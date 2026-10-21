import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RepoChip } from "../src/look/RepoChip";

const GITHUB = {
  slug: "example-org/example-repo",
  url: "https://github.com/example-org/example-repo",
};

describe("RepoChip", () => {
  it("a link to the repository: the GitHub mark and owner/repo, in a new tab", () => {
    const { container } = render(<RepoChip github={GITHUB} />);
    const a = screen.getByRole("link", { name: "example-org/example-repo on GitHub" });
    expect(a).toHaveAttribute("href", GITHUB.url);
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a).toHaveClass("chip", "chip--repo");
    expect(a).toHaveTextContent("example-org/example-repo");
    const mark = a.querySelector("svg.gh-mark");
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  it("no github, or a malformed one: nothing", () => {
    expect(render(<RepoChip github={undefined} />).container).toBeEmptyDOMElement();
    expect(
      render(<RepoChip github={{ slug: "just-a-name", url: GITHUB.url }} />).container,
    ).toBeEmptyDOMElement();
  });
});
