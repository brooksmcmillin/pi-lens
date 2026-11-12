import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The recording host's bus surface exercised by the sampler regression. */
export function makeHost(): { pi: Pick<ExtensionAPI, "events"> };
