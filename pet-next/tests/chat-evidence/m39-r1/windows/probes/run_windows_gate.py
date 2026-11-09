import json, os, pathlib, shutil, subprocess, time
ROOT = pathlib.Path(__file__).resolve().parent
APP = ROOT / '中文 空格 package'
NODE = shutil.which('node')
PNPM = ROOT.parent / 'm36-r1-b8eaf23/tools/node_modules/pnpm/bin/pnpm.cjs'
ENV = {k:v for k,v in os.environ.items() if not k.startswith('PET_NEXT_') and k not in ('NODE_OPTIONS','ELECTRON_RUN_AS_NODE','ELECTRON_SKIP_BINARY_DOWNLOAD')}
for key in list(ENV):
    if key.lower() == 'path':
        inherited_path = ENV.pop(key)
ENV['Path'] = str(PNPM.parent.parent.parent / '.bin') + os.pathsep + str(pathlib.Path(NODE).parent) + os.pathsep + inherited_path
def run(label, args, limit=120):
    start=time.monotonic(); log=ROOT/f'windows-m39-{label}.log'
    with log.open('wb') as f:
        p=subprocess.Popen(args,cwd=APP,env=ENV,stdout=f,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
        timeout=False
        try: code=p.wait(timeout=limit)
        except subprocess.TimeoutExpired:
            timeout=True
            subprocess.run(['taskkill','/PID',str(p.pid),'/T','/F'],capture_output=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
            code=p.wait(timeout=15)
    result={'label':label,'args':args,'cwd':str(APP),'pid':p.pid,'code':code,'timeout':timeout,'seconds':round(time.monotonic()-start,2),'log':str(log)}
    (ROOT/f'windows-m39-{label}-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(result,ensure_ascii=True),flush=True)
    return code
if __name__=='__main__':
    import sys
    mode=sys.argv[1]
    if mode=='setup':
        if run('install',[NODE,str(PNPM),'install','--frozen-lockfile']): sys.exit(1)
        if run('build',[NODE,str(PNPM),'build']): sys.exit(1)
        tests=[str(p.relative_to(APP)).replace('\\','/') for p in sorted((APP/'core/idle-suspension').glob('*.test.ts'))]
        tests+=['adapters/media/idle-suspension.test.ts','electron/window-visibility.test.ts']
        sys.exit(run('modules',[NODE,'--experimental-strip-types','--test','--test-concurrency=1',*tests]))
    if mode=='e2e':
        sys.exit(run('idle-windows',[NODE,'--experimental-strip-types','--test','--test-concurrency=1','tests/idle-windows.check.ts']))
    if mode=='hide':
        sys.exit(run('idle-hide-delta',[NODE,'--experimental-strip-types','--test','--test-concurrency=1','--test-name-pattern=开启后','tests/idle-windows-delta.check.ts']))
