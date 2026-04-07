import { describe, expect, it, vi } from "vitest";

import { createPluginRuntimeServices } from "../app/runtime.js";

describe("createPluginRuntimeServices", () => {
    it("does not require full channel account config during plugin bootstrap", () => {
        const api = {
            config: {
                channels: {
                    "clawswarm": {
                        accounts: {
                            default: {},
                        },
                    },
                },
            },
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
                child: vi.fn(() => ({
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: vi.fn(),
                    debug: vi.fn(),
                })),
            },
        };

        expect(() => createPluginRuntimeServices(api as never)).not.toThrow();
    });
});
