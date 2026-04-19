#!/usr/bin/env python3
"""Expand #include directives and run glslangValidator on full shader entry points."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHADER_DIR = ROOT / "shaders"

INCLUDE_RE = re.compile(r'^#include\s+"([^"]+)"\s*$')

# Single-output fragment programs (MRT shaders use GL_EXT_draw_buffers; glslang
# does not validate those the same way as browsers, so they are skipped here).
FRAGMENTS = [
    "compose-frag",
    "pass-frag",
    "ray-frag",
    "blend-test-frag",
    "blend-test-pack-frag",
]

VERTS = ["compose-vert", "init-vert", "ray-vert", "trace-vert", "blend-test-vert"]


def expand(name: str, visited: set[str] | None = None) -> str:
    if visited is None:
        visited = set()
    if name in visited:
        raise RuntimeError(f"circular include: {name}")
    visited.add(name)
    path = SHADER_DIR / f"{name}.txt"
    if not path.is_file():
        visited.remove(name)
        raise FileNotFoundError(path)
    out: list[str] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            m = INCLUDE_RE.match(line.strip())
            if m:
                out.append(expand(m.group(1), visited))
            else:
                out.append(line)
    finally:
        visited.remove(name)
    return "\n".join(out)


def main() -> int:
    glslang = shutil.which("glslangValidator")
    if not glslang:
        print("validate_shaders: glslangValidator not found; skipping", file=sys.stderr)
        return 0

    errors = 0
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        for name in VERTS:
            src = expand(name)
            f = tmp_path / f"{name}.vert"
            f.write_text("#version 100\n" + src + "\n", encoding="utf-8")
            r = subprocess.run([glslang, "-S", "vert", str(f)], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"FAIL {name} (vert):\n{r.stdout}\n{r.stderr}", file=sys.stderr)
                errors += 1
        for name in FRAGMENTS:
            src = expand(name)
            f = tmp_path / f"{name}.frag"
            f.write_text("#version 100\n" + src + "\n", encoding="utf-8")
            r = subprocess.run([glslang, "-S", "frag", str(f)], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"FAIL {name} (frag):\n{r.stdout}\n{r.stderr}", file=sys.stderr)
                errors += 1

    if errors:
        print(f"validate_shaders: {errors} shader(s) failed validation", file=sys.stderr)
        return 1
    print("validate_shaders: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
