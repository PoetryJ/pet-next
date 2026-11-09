#!/usr/bin/env python3
"""M3-10 D：Windows 便携 ZIP 的独立静态验收。

只读检查 C 的产物，不从源码旁路启动；Windows 运行期验收本机 not-run。
用法：python3 tests/portable-accept/verify-portable-zip.py <zip> <manifest> <extract-root> <json-out>
"""
import hashlib
import json
import os
import pathlib
import shutil
import struct
import sys
import zipfile

FORBIDDEN = ("node_modules/", "/tests/", "/bench/", "chat-evidence", ".git/", "assets-pipeline/", "experiments/", "/.env", "id_rsa", "known_hosts")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pe_info(path):
    data = pathlib.Path(path).read_bytes()
    if data[:2] != b"MZ":
        return {"ok": False, "reason": "not MZ"}
    offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[offset:offset + 4] != b"PE\0\0":
        return {"ok": False, "reason": "not PE"}
    machine, = struct.unpack_from("<H", data, offset + 4)
    subsystem, = struct.unpack_from("<H", data, offset + 0x5C)
    return {"ok": machine == 0x8664, "machine": hex(machine), "subsystem": subsystem,
            "pe32plus": struct.unpack_from("<H", data, offset + 24)[0] == 0x20B}


def main():
    zip_path, manifest_path, extract_root, out_path = map(pathlib.Path, sys.argv[1:5])
    manifest = json.loads(manifest_path.read_text())
    result = {"zip": str(zip_path), "manifest": str(manifest_path), "checks": {}, "failures": []}

    def check(name, ok, detail=None):
        result["checks"][name] = {"ok": bool(ok), "detail": detail}
        if not ok:
            result["failures"].append(name)

    zip_sha = sha256(zip_path)
    check("zip_sha_matches_manifest", zip_sha == manifest["zip"]["sha256"], {"actual": zip_sha, "expected": manifest["zip"]["sha256"]})
    check("zip_bytes_matches_manifest", zip_path.stat().st_size == manifest["zip"]["bytes"])

    extract_root = extract_root / "中文 空格 便携包"
    if extract_root.exists():
        shutil.rmtree(extract_root)
    extract_root.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        check("zip_integrity", zf.testzip() is None)
        names = zf.namelist()
        zf.extractall(extract_root)
    check("entries_match_manifest", len(names) == manifest["package"]["entries"], {"zip": len(names), "manifest": manifest["package"]["entries"]})
    leaks = [name for name in names if any(token in name for token in FORBIDDEN)]
    check("no_forbidden_paths", not leaks, leaks[:10])

    top = extract_root / "PetNext-win32-x64"
    exe = top / "PetNext.exe"
    check("petnext_exe_exists", exe.is_file())
    info = pe_info(exe) if exe.is_file() else {"ok": False}
    check("petnext_pe64_gui", info.get("ok") is True and info.get("pe32plus") is True and info.get("subsystem") == 2, info)

    app = top / "resources" / "app"
    pkg = json.loads((app / "package.json").read_text())
    check("app_main_is_packaged_entry", pkg.get("main") == "dist/electron/packaged-main.js", pkg.get("main"))
    check("app_type_module", pkg.get("type") == "module")
    check("no_dev_dependencies", "devDependencies" not in pkg and "dependencies" not in pkg)
    check("packaged_entry_exists", (app / "dist/electron/packaged-main.js").is_file())
    entry_text = (app / "dist/electron/packaged-main.js").read_text()
    check("packaged_entry_imports_main", "./main.js" in entry_text)
    check("main_preload_exist", (app / "dist/electron/main.js").is_file() and (app / "dist/electron/preload.js").is_file())
    for rel in ("dist/app/page.html", "dist/app/launcher.html", "dist/app/page.js", "dist/app/launcher.js", "dist/assets/idle.webm"):
        check(f"runtime_{rel}", (app / rel).is_file())
    for rel in ("LICENSE", "LICENSES.chromium.html"):
        check(f"electron_license_{rel}", (top / rel).is_file())
    check("project_license_attribution", (app / "LICENSE").is_file() and "PC2005-cloud" in (app / "LICENSE").read_text())
    check("readme_attribution", (app / "README.md").is_file())

    # 全量逐文件 SHA 对照 manifest（197 项，成本可接受）。
    mismatches = []
    for item in manifest["files"]:
        path = top / item["path"].split("/", 1)[1]
        if not path.is_file() or sha256(path) != item["sha256"]:
            mismatches.append(item["path"])
    check("all_file_sha_match_manifest", not mismatches, mismatches[:5])

    decompressed = sum(path.stat().st_size for path in top.rglob("*") if path.is_file())
    result["sizes"] = {"zip": zip_path.stat().st_size, "extracted": decompressed,
                       "json": sum(1 for _ in top.rglob("*.json"))}
    result["manifest_summary"] = {key: manifest[key] for key in ("gitSha", "electronVersion", "packagerVersion", "platform", "arch", "appVersion", "buildSeconds")}
    result["windows_runtime"] = {"status": "not-run", "reason": "no Windows host in this environment",
                                 "required": "extract to Chinese+space path, launch PetNext.exe, config/save/probe/start/exit/reopen; PATH without node/pnpm/git"}
    result["ok"] = not result["failures"]
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"ok": result["ok"], "failures": result["failures"], "sizes": result["sizes"], "checks": len(result["checks"])}, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
