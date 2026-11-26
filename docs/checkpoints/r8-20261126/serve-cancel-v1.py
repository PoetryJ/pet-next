"""Local-only Transformers inference for paired memory experiments.

No model download, credential lookup, hidden chat history, or synthetic fallback.
Every completion records its exact request, generation settings, and raw output.
"""
import argparse
import hashlib
import json
import os
import select
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
import torch
import transformers
from transformers import AutoModelForCausalLM, AutoTokenizer, StoppingCriteria, StoppingCriteriaList

p = argparse.ArgumentParser()
p.add_argument('--model-path', required=True)
p.add_argument('--model-id', required=True)
p.add_argument('--output', required=True)
p.add_argument('--port', type=int, default=18881)
p.add_argument('--context-limit', type=int, default=16384)
p.add_argument('--device', default='cuda:0')
args = p.parse_args()
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
tokenizer = AutoTokenizer.from_pretrained(args.model_path, local_files_only=True)
model = AutoModelForCausalLM.from_pretrained(
    args.model_path, local_files_only=True, torch_dtype=torch.bfloat16,
    attn_implementation='sdpa', device_map={'': args.device},
).eval()
generation_lock = threading.Lock()
log_lock = threading.Lock()
manifest = {
    'model': args.model_id, 'path': str(Path(args.model_path).resolve()),
    'torch': torch.__version__, 'cuda': torch.version.cuda,
    'transformers': transformers.__version__, 'dtype': 'bfloat16',
    'device': args.device, 'gpu': torch.cuda.get_device_name(),
    'contextLimit': args.context_limit, 'enableThinking': False,
    'configSha256': hashlib.sha256(Path(args.model_path, 'config.json').read_bytes()).hexdigest(),
    'pid': os.getpid(), 'port': args.port,
    'serviceRevision': 'disconnect-cancellation-v1',
}
(out / 'environment.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')


def record(value):
    with log_lock:
        with (out / 'requests.jsonl').open('a', encoding='utf-8') as f:
            f.write(json.dumps(value, ensure_ascii=False) + '\n')
            f.flush()


def encode(messages):
    return tokenizer.apply_chat_template(
        messages, tokenize=True, add_generation_prompt=True,
        enable_thinking=False, return_tensors='pt', return_dict=True,
    )


class DisconnectedClient(StoppingCriteria):
    """Stop a superseded request rather than spending GPU time on a closed client."""
    def __init__(self, connection):
        self.connection = connection
        self.cancelled = False

    def disconnected(self):
        if self.cancelled:
            return True
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            if readable and self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b'':
                self.cancelled = True
        except (ConnectionError, OSError):
            self.cancelled = True
        return self.cancelled

    def __call__(self, input_ids, scores, **kwargs):
        return self.disconnected()


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            return self.send_json(200, {'ready': True, **manifest})
        if self.path == '/v1/models':
            return self.send_json(200, {'object': 'list', 'data': [{'id': args.model_id, 'object': 'model'}]})
        return self.send_json(404, {'error': 'not_found'})

    def do_POST(self):
        started = time.time()
        rid = 'chatcmpl-' + uuid.uuid4().hex
        body = None
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 2_000_000:
                raise ValueError('body_size_invalid')
            body = json.loads(self.rfile.read(length))
            if self.path not in ['/v1/chat/completions', '/tokenize']:
                return self.send_json(404, {'error': 'not_found'})
            if body.get('model', args.model_id) != args.model_id:
                raise ValueError('model_mismatch')
            messages = body.get('messages')
            if not isinstance(messages, list) or not messages:
                raise ValueError('messages_required')
            if any(m.get('role') not in ['system', 'user', 'assistant'] or not isinstance(m.get('content'), str) for m in messages):
                raise ValueError('invalid_message')
            inputs = encode(messages)
            prompt_tokens = inputs['input_ids'].shape[-1]
            if self.path == '/tokenize':
                return self.send_json(200, {'model': args.model_id, 'prompt_tokens': prompt_tokens, 'context_limit': args.context_limit})
            if body.get('stream', False):
                raise ValueError('stream_not_supported')
            if body.get('tools') or body.get('response_format', {}).get('type') not in [None, 'text', 'json_object']:
                raise ValueError('unsupported_request_feature')
            if body.get('enable_thinking', False):
                raise ValueError('thinking_disabled_for_this_server')
            max_new = int(body.get('max_tokens', 768))
            if not 1 <= max_new <= 4096:
                raise ValueError('max_tokens_out_of_range')
            if prompt_tokens + max_new > args.context_limit:
                raise ValueError(f'context_limit_exceeded:{prompt_tokens}+{max_new}>{args.context_limit}')
            temperature = float(body.get('temperature', 0))
            top_p = float(body.get('top_p', 1))
            seed = int(body.get('seed', 17))
            if not 0 <= temperature <= 2 or not 0 < top_p <= 1:
                raise ValueError('sampling_out_of_range')
            params = {'max_new_tokens': max_new, 'do_sample': temperature > 0,
                      'pad_token_id': tokenizer.pad_token_id or tokenizer.eos_token_id}
            if temperature > 0:
                params.update(temperature=temperature, top_p=top_p)
            queued = time.time()
            cancellation = DisconnectedClient(self.connection)
            with generation_lock:
                if cancellation.disconnected():
                    record({'id': rid, 'startedAt': started, 'request': body, 'cancelled': True,
                            'phase': 'before_generation', 'modelManifest': manifest})
                    return
                torch.manual_seed(seed)
                torch.cuda.manual_seed_all(seed)
                inference_started = time.time()
                with torch.inference_mode():
                    generated = model.generate(**inputs.to(model.device), **params,
                                               stopping_criteria=StoppingCriteriaList([cancellation]))
                torch.cuda.synchronize()
                inference_ended = time.time()
            new_ids = generated[0, prompt_tokens:].tolist()
            raw_text = tokenizer.decode(new_ids, skip_special_tokens=True)
            eos_ids = model.generation_config.eos_token_id
            if isinstance(eos_ids, int):
                eos_ids = [eos_ids]
            finish = 'stop' if new_ids and new_ids[-1] in (eos_ids or []) else 'length'
            if cancellation.cancelled:
                record({'id': rid, 'startedAt': started, 'request': body, 'generation': params,
                        'cancelled': True, 'phase': 'generation', 'partialOutput': raw_text,
                        'outputTokenIds': new_ids,
                        'usage': {'prompt_tokens': prompt_tokens, 'completion_tokens': len(new_ids)},
                        'measurement': {'queue_seconds': inference_started - queued, 'inference_seconds': inference_ended - inference_started},
                        'modelManifest': manifest})
                return
            result = {'id': rid, 'object': 'chat.completion', 'created': int(started), 'model': args.model_id,
                      'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': raw_text}, 'finish_reason': finish}],
                      'usage': {'prompt_tokens': prompt_tokens, 'completion_tokens': len(new_ids), 'total_tokens': prompt_tokens + len(new_ids)},
                      'system_fingerprint': manifest['configSha256'][:16],
                      'measurement': {'queue_seconds': inference_started - queued, 'inference_seconds': inference_ended - inference_started,
                                      'total_seconds': time.time() - started, 'enable_thinking': False, 'seed': seed}}
            record({'id': rid, 'startedAt': started, 'request': body, 'generation': params,
                    'response': result, 'outputTokenIds': new_ids, 'modelManifest': manifest})
            self.send_json(200, result)
        except Exception as exc:
            code = 400 if isinstance(exc, (ValueError, TypeError, KeyError, json.JSONDecodeError)) else 500
            record({'id': rid, 'startedAt': started, 'request': body, 'error': {'type': type(exc).__name__, 'message': str(exc)}})
            self.send_json(code, {'error': {'type': type(exc).__name__, 'message': str(exc), 'request_id': rid}})


print(json.dumps({'ready': True, **manifest}), flush=True)
ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
