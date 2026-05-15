"""Merge conflicting git files by accepting both sides' changes."""
import re
import sys

def resolve_conflicts(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')
    result = []
    i = 0
    conflicts = 0

    while i < len(lines):
        if lines[i].startswith('<<<<<<< '):
            conflicts += 1
            # Skip HEAD section start
            head_lines = []
            i += 1
            while i < len(lines) and not lines[i].startswith('======='):
                head_lines.append(lines[i])
                i += 1
            # Skip =======
            i += 1
            # Collect their section
            their_lines = []
            while i < len(lines) and not lines[i].startswith('>>>>>>> '):
                their_lines.append(lines[i])
                i += 1
            # Skip >>>>>>>
            i += 1

            # If both sides are identical, keep once
            if head_lines == their_lines:
                result.extend(head_lines)
            else:
                # Keep both sides, HEAD first then their
                result.extend(head_lines)
                # Add a blank line separator if both sides have content
                if head_lines and head_lines[-1].strip():
                    result.append('')
                result.extend(their_lines)
        else:
            result.append(lines[i])
            i += 1

    if conflicts == 0:
        print(f'  {filepath}: no conflicts found (skipped)')
        return False

    new_content = '\n'.join(result)
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)

    print(f'  {filepath}: resolved {conflicts} conflicts (kept both sides)')
    return True

if __name__ == '__main__':
    files = [
        'src/App.jsx',
        'src/components/SessionTimeline.jsx',
        'src/projectStorageModel.js',
        'src/projectStorageModel.test.mjs',
    ]
    for fp in files:
        resolve_conflicts(fp)
