import { spawn } from "node:child_process";

/** The platform's opener (`open` on macOS, else `xdg-open`), detached: the CLI does not wait. */
export function openUrl(url: string): Promise<boolean> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve) => {
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
