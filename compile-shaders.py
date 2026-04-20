#!/usr/bin/env python3
"""Pack GLSL sources under shaders/ into src/tantalum-shaders.js for the browser."""

from pathlib import Path

SHADER_DIR = Path("shaders/glsl")
OUT_PATH = Path("src/tantalum-shaders.js")
MAX_LEN = 80


def main() -> None:
    entries = []
    for path in sorted(SHADER_DIR.glob("*.txt")):
        text = path.read_text(encoding="utf-8").strip()
        lines = text.split("\n") if text else []

        split_lines: list[str] = []
        for line in lines:
            if not line.strip():
                if split_lines:
                    split_lines[-1] = split_lines[-1][:-1] + "\\n'"
                    split_lines.append("")
                else:
                    split_lines.append("''")
            else:
                just_len = min(len(line), MAX_LEN)
                parts = [line[i : i + MAX_LEN] for i in range(0, len(line), MAX_LEN)]
                for part in parts[:-1]:
                    split_lines.append(("'" + part + "'").rjust(just_len))
                split_lines.append(("'" + parts[-1] + "\\n'").rjust(just_len))

        if not split_lines:
            continue

        line_len = len(max(split_lines, key=len))
        source = ""
        for i, sline in enumerate(split_lines):
            if sline:
                source += "        "
                if i < len(split_lines) - 1:
                    source += sline.ljust(line_len) + " +"
                else:
                    source += sline
            if i < len(split_lines) - 1:
                source += "\n"

        key = path.stem
        entries.append(f"    '{key}':\n{source}")

    body = "window.Shaders = {\n" + ",\n\n".join(entries) + "\n};\n"
    OUT_PATH.write_text(body, encoding="utf-8")


if __name__ == "__main__":
    main()
