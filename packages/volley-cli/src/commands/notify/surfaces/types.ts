import type { Envelope } from "volley-mcp/envelope";

export type SurfaceName = "bell" | "desktop" | "webhook";

export interface FireInput {
  readonly topic: string;
  readonly envelope: Envelope;
}

export interface Surface {
  readonly name: SurfaceName;
  fire(input: FireInput): Promise<void>;
}
