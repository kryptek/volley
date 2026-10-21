/**
 * The repository chip: the GitHub mark and `owner/repo`, a link to the repository in a new tab
 * (the wave state's `github`, SPEC §4.6.1). Nothing at all without a well-formed `github`: an
 * older supervisor, or a read that failed.
 */
import { githubOf } from "../lib/github";
import { GitHubMark } from "./GitHubMark";

export function RepoChip({ github }: { github: unknown }) {
  const gh = githubOf(github);
  if (gh === undefined) return null;
  return (
    <a
      className="chip chip--repo"
      href={gh.url}
      target="_blank"
      rel="noopener noreferrer"
      title={gh.url}
      aria-label={`${gh.slug} on GitHub`}
    >
      <GitHubMark size={12} />
      {gh.slug}
    </a>
  );
}
