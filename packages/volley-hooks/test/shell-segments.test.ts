import { describe, expect, it } from "vitest";
import { executableSegments } from "../src/lib/shell-segments";

const seg = executableSegments;

describe("executableSegments", () => {
  it("splits on ;, &&, ||, |, & and newlines", () => {
    expect(seg("bun run test && echo done")).toEqual(["bun run test", "echo"]);
    expect(seg("a; b || c | d & e\nf")).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(seg("cd packages/x && bunx vitest run")).toEqual(["cd packages/x", "bunx vitest run"]);
  });

  it("drops # comments, but not a # inside a word or quotes", () => {
    expect(seg("# bun run test")).toEqual([]);
    expect(seg("ls # bun run test\npwd")).toEqual(["ls", "pwd"]);
    expect(seg("grep a#b 'x # y'")).toEqual(["grep a#b x # y"]);
  });

  it("drops heredoc bodies, quoted delimiter or not, and redirect targets", () => {
    expect(seg("cat <<'EOF' > notes.md\nrun bun run test later\nEOF")).toEqual(["cat"]);
    expect(seg('cat <<"END"\nbun run test\nEND\nls')).toEqual(["cat", "ls"]);
    expect(seg("cat <<EOF >> f\nbun run test\nEOF\nmvn verify")).toEqual(["cat", "mvn verify"]);
    expect(seg("cat <<-EOF\n\tbun run test\n\tEOF\npwd")).toEqual(["cat", "pwd"]);
    expect(seg("bun run test > out.log 2>&1 | tee x")).toEqual(["bun run test", "tee x"]);
    expect(seg("cat <<< 'bun run test'")).toEqual(["cat"]);
  });

  it("drops the arguments of echo and printf", () => {
    expect(seg('echo "run bun run test"')).toEqual(["echo"]);
    expect(seg("printf '%s\\n' 'bun run test'")).toEqual(["printf"]);
  });

  it("drops commit and PR message text", () => {
    expect(seg('git commit -m "fix: bun run test flake"')).toEqual(["git commit"]);
    expect(seg("git commit --message='bun run test' -q")).toEqual(["git commit -q"]);
    expect(seg('git commit -am "fix: bun run test flake"')).toEqual(["git commit -am"]);
    expect(seg("git commit -qm 'bun run test' --no-verify")).toEqual([
      "git commit -qm --no-verify",
    ]);
    expect(seg('gh pr create --title "bun run test" --body "x" --base main')).toEqual([
      "gh pr create --base main",
    ]);
    expect(seg("gh issue comment 3 -b 'mvn verify'")).toEqual(["gh issue comment 3"]);
  });

  it("keeps the inner script of sh -c / bash -c / eval as segments", () => {
    expect(seg('bash -c "bun run test"')).toEqual(["bash", "bun run test"]);
    expect(seg("sh -ec 'cd x && mvn -q verify'")).toEqual(["sh", "cd x", "mvn -q verify"]);
    expect(seg(`bash -c "echo 'bun run test'"`)).toEqual(["bash", "echo"]);
    expect(seg("eval 'npm run build'")).toEqual(["npm run build"]);
  });

  it("splits out $(…), backticks and process substitutions, even inside double quotes", () => {
    expect(seg("x=$(bun run test)")).toEqual(["bun run test"]);
    expect(seg('echo "result: $(npm run build | tail -1)"')).toEqual([
      "npm run build",
      "tail -1",
      "echo",
    ]);
    expect(seg("echo `mvn verify`")).toEqual(["mvn verify", "echo"]);
    expect(seg("diff <(bun run test) b")).toEqual(["bun run test", "diff b"]);
    expect(seg("echo '$(bun run test)'")).toEqual(["echo"]);
  });

  it("handles subshells, groups, keywords and env assignments", () => {
    expect(seg("(cd x && bun run test)")).toEqual(["cd x", "bun run test"]);
    expect(seg("{ bun run test; }")).toEqual(["bun run test"]);
    expect(seg("if bun run test; then echo ok; fi")).toEqual(["bun run test", "echo"]);
    expect(seg("CI=1 FOO='a b' bun run test")).toEqual(["bun run test"]);
    expect(seg("$(echo x) && (a) && b")).toEqual(["echo", "a", "b"]);
  });

  it("handles escapes and line continuations", () => {
    expect(seg("bun run \\\n  test")).toEqual(["bun run test"]);
    expect(seg("echo a\\;b; ls")).toEqual(["echo", "ls"]);
    expect(seg('git commit -m "say \\"bun run test\\" now"')).toEqual(["git commit"]);
  });

  it("never throws on unterminated quotes, substitutions or heredocs", () => {
    expect(seg("echo 'abc")).toEqual(["echo"]);
    expect(seg("x=$(bun run test")).toEqual(["bun run test"]);
    expect(seg("cat <<EOF\nbun run test")).toEqual(["cat"]);
    expect(seg("")).toEqual([]);
  });
});
