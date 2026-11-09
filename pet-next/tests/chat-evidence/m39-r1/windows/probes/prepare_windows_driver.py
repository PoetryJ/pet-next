from pathlib import Path
import difflib
root=Path(__file__).resolve().parent
app=root/'中文 空格 package'
original=(app/'tests/idle-suspension.e2e.test.ts').read_text(encoding='utf8')
modified=original.replace("const isolation = (await import('../scripts/test-run-context.mjs'))", "const isolationSource = (await import('../scripts/test-run-context.mjs'))",1)
needle='\ninterface RunContext {'
insert="\n// Independent Windows driver: native desktop/WM, no Xvfb/openbox.\nconst isolation = { ...isolationSource, startOwnXvfb: async () => ({ display: '', stop: async () => {} }) };\n"
assert needle in modified
modified=modified.replace(needle,insert+needle,1)
needle='async function startWm(display: string): Promise<WindowManager> {\n'
assert needle in modified
modified=modified.replace(needle,needle+"  if (process.platform === 'win32') return { available: true, stop() {} };\n",1)
needle='      DISPLAY: options.display,\n'
assert needle in modified
modified=modified.replace(needle,needle+"      PET_NEXT_PREVIEW: 'short,behavior',\n",1)
(app/'tests/idle-windows.check.ts').write_text(modified,encoding='utf8')
(root/'windows-driver.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True),modified.splitlines(True),fromfile='tests/idle-suspension.e2e.test.ts',tofile='tests/idle-windows.check.ts')),encoding='utf8')
