# Volley's Homebrew formula, a template: the release workflow (.github/workflows/release.yml)
# renders it for a tag (`bun scripts/packaging/formula.ts render`, which fills in the version and
# the sha256 of the release tarball) and pushes the result to the tap. See packaging/README.md.
class Volley < Formula
  desc "Agent messaging over MQTT, with a wave supervisor and a dashboard"
  homepage "https://github.com/kryptek/volley"
  url "https://github.com/kryptek/volley/releases/download/v@VERSION@/volley-@VERSION@.tar.gz"
  sha256 "@SHA256@"
  license "Apache-2.0"

  depends_on "gh"
  depends_on "git"
  depends_on "mosquitto"
  depends_on "oven-sh/bun/bun"
  depends_on "tmux"

  def install
    # The release tarball is a checkout with its node_modules: nothing is downloaded here.
    libexec.install Dir["*"]
    bun = formula_opt_bin("oven-sh/bun/bun")/"bun"
    [["volley", "volley-cli"], ["volleyd", "volleyd"]].each do |name, pkg|
      (bin/name).write <<~SH
        #!/bin/sh
        exec "#{bun}" "#{opt_libexec}/packages/#{pkg}/src/cli.ts" "$@"
      SH
    end
  end

  def caveats
    <<~EOS
      Run `volley setup` next: it configures the broker, installs volleyd and the Desk as
      launchd services and signs you in. Run it again after each `brew upgrade volley`:
      it rebuilds the Desk for the new version and restarts the services.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/volley --version")
  end
end
