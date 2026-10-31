"""Exercise the actual version-PR shell against repository-policy outcomes."""
from pathlib import Path
import os
import subprocess
import tempfile

workflow = (Path(__file__).resolve().parents[1] / "workflows/release.yml").read_text()
start = workflow.index("            pr=$(gh pr list")
end = workflow.index("            exit 0", start) + len("            exit 0")
shell = "set -euo pipefail\n" + "\n".join(line[12:] for line in workflow[start:end].splitlines()) + "\n"
with tempfile.TemporaryDirectory(prefix="ovdb-version-handoff-") as directory:
    root = Path(directory)
    (root / "run.sh").write_text(shell)
    (root / "gh").write_text(r"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_LOG"
if [[ "$1 $2" == 'pr list' ]]; then
  count=0
  [[ ! -f "$MOCK_COUNT" ]] || count=$(cat "$MOCK_COUNT")
  count=$((count+1))
  printf '%s' "$count" > "$MOCK_COUNT"
  if [[ "$CASE" == existing || ( "$count" -gt 1 && ( "$CASE" == created || "$CASE" == denied_race ) ) ]]; then echo 8; fi
elif [[ "$1 $2" == 'pr create' ]]; then
  if [[ "$CASE" == denied || "$CASE" == denied_race ]]; then
    echo 'GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)' >&2
    exit 1
  elif [[ "$CASE" == unrelated ]]; then
    echo 'GraphQL: Resource not accessible by integration' >&2
    exit 1
  fi
else exit 99
fi
""")
    (root / "git").write_text("#!/usr/bin/env bash\n[[ \"$*\" == 'rev-parse HEAD' ]] || exit 99\necho aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")
    for name in ["gh", "git"]: (root / name).chmod(0o755)
    for case in ["existing", "created", "denied", "denied_race", "unrelated", "success_missing"]:
        log = root / (case + ".log")
        summary = root / (case + ".summary")
        env = dict(os.environ, PATH=str(root) + ":" + os.environ["PATH"], CASE=case, MOCK_LOG=str(log), MOCK_COUNT=str(root / (case + ".count")), GITHUB_STEP_SUMMARY=str(summary), GITHUB_REPOSITORY="openvaultdb/openvaultdb-ts")
        result = subprocess.run(["bash", str(root / "run.sh")], env=env, capture_output=True, text=True)
        assert (result.returncode == 0) == (case not in ["unrelated", "success_missing"]), (case, result.stderr)
        assert summary.exists() == (case == "denied"), case
        if case == "denied":
            assert "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" in summary.read_text()
            assert "No package was published" in summary.read_text()
        if case == "existing": assert "pr create" not in log.read_text()
        if case == "unrelated": assert "Resource not accessible by integration" in result.stderr
        print("PASS version-PR handoff", case)
