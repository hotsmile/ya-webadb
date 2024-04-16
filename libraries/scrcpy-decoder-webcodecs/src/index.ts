import { EventEmitter } from "@yume-chan/event";
import type {
    ScrcpyMediaStreamDataPacket,
    ScrcpyMediaStreamPacket,
} from "@yume-chan/scrcpy";
import {
    ScrcpyVideoCodecId,
    h264ParseConfiguration,
    h265ParseConfiguration,
} from "@yume-chan/scrcpy";
import { getUint32LittleEndian } from "@yume-chan/no-data-view";
import type {
    ScrcpyVideoDecoder,
    ScrcpyVideoDecoderCapability,
} from "@yume-chan/scrcpy-decoder-tinyh264";
import { WritableStream } from "@yume-chan/stream-extra";

import { BitmapFrameRenderer } from "./bitmap.js";
import type { FrameRenderer } from "./renderer.js";
import { WebGLFrameRenderer } from "./webgl.js";

function toHex(value: number) {
    return value.toString(16).padStart(2, "0").toUpperCase();
}

export class WebCodecsDecoder implements ScrcpyVideoDecoder {
    static isSupported() {
        return typeof globalThis.VideoDecoder !== "undefined";
    }

    static readonly capabilities: Record<string, ScrcpyVideoDecoderCapability> =
        {
            h264: {},
            h265: {},
        };

    #codec: ScrcpyVideoCodecId;
    get codec() {
        return this.#codec;
    }

    #writable: WritableStream<ScrcpyMediaStreamPacket>;
    get writable() {
        return this.#writable;
    }

    #canvas: HTMLCanvasElement;
    get renderer() {
        return this.#canvas;
    }

    #frameRendered = 0;
    get frameRendered() {
        return this.#frameRendered;
    }

    #frameSkipped = 0;
    get frameSkipped() {
        return this.#frameSkipped;
    }

    #sizeChanged = new EventEmitter<{ width: number; height: number }>();
    get sizeChanged() {
        return this.#sizeChanged.event;
    }

    #decoder: VideoDecoder;
    #config: Uint8Array | undefined;
    #renderer: FrameRenderer;

    #currentFrameRendered = false;
    #animationFrameId = 0;

    constructor(codec: ScrcpyVideoCodecId) {
        this.#codec = codec;

        this.#canvas = document.createElement("canvas");

        try {
            this.#renderer = new WebGLFrameRenderer(this.#canvas);
        } catch {
            this.#renderer = new BitmapFrameRenderer(this.#canvas);
        }

        this.#decoder = new VideoDecoder({
            output: (frame) => {
                if (this.#currentFrameRendered) {
                    this.#frameRendered += 1;
                } else {
                    this.#frameSkipped += 1;
                }
                this.#currentFrameRendered = false;

                // PERF: H.264 renderer may draw multiple frames in one vertical sync interval to minimize latency.
                // When multiple frames are drawn in one vertical sync interval,
                // only the last one is visible to users.
                // But this ensures users can always see the most up-to-date screen.
                // This is also the behavior of official Scrcpy client.
                // https://github.com/Genymobile/scrcpy/issues/3679
                this.#renderer.draw(frame);
            },
            error(e) {
                console.warn(
                    "[@yume-chan/scrcpy-decoder-webcodecs]",
                    "VideoDecoder error",
                    e,
                );
            },
        });

        this.#writable = new WritableStream<ScrcpyMediaStreamPacket>({
            write: (packet) => {
                switch (packet.type) {
                    case "configuration":
                        this.#configure(packet.data);
                        break;
                    case "data":
                        this.#decode(packet);
                        break;
                }
            },
        });

        this.#onFramePresented();
    }

    #onFramePresented = () => {
        this.#currentFrameRendered = true;
        this.#animationFrameId = requestAnimationFrame(this.#onFramePresented);
    };

    #configureH264(data: Uint8Array) {
        const {
            profileIndex,
            constraintSet,
            levelIndex,
            croppedWidth,
            croppedHeight,
        } = h264ParseConfiguration(data);

        this.#canvas.width = croppedWidth;
        this.#canvas.height = croppedHeight;
        this.#sizeChanged.fire({
            width: croppedWidth,
            height: croppedHeight,
        });

        // https://www.rfc-editor.org/rfc/rfc6381#section-3.3
        // ISO Base Media File Format Name Space
        const codec =
            "avc1." +
            toHex(profileIndex) +
            toHex(constraintSet) +
            toHex(levelIndex);
        this.#decoder.configure({
            codec: codec,
            optimizeForLatency: true,
        });
    }

    #configureH265(data: Uint8Array) {
        const {
            generalProfileSpace,
            generalProfileIndex,
            generalProfileCompatibilitySet,
            generalTierFlag,
            generalLevelIndex,
            generalConstraintSet,
            croppedWidth,
            croppedHeight,
        } = h265ParseConfiguration(data);

        this.#canvas.width = croppedWidth;
        this.#canvas.height = croppedHeight;
        this.#sizeChanged.fire({
            width: croppedWidth,
            height: croppedHeight,
        });

        const codec = [
            "hev1",
            ["", "A", "B", "C"][generalProfileSpace]! +
                generalProfileIndex.toString(),
            getUint32LittleEndian(generalProfileCompatibilitySet, 0).toString(
                16,
            ),
            (generalTierFlag ? "H" : "L") + generalLevelIndex.toString(),
            getUint32LittleEndian(generalConstraintSet, 0)
                .toString(16)
                .toUpperCase(),
            getUint32LittleEndian(generalConstraintSet, 4)
                .toString(16)
                .toUpperCase(),
        ].join(".");
        this.#decoder.configure({
            codec,
            optimizeForLatency: true,
        });
    }

    #configure(data: Uint8Array) {
        switch (this.#codec) {
            case ScrcpyVideoCodecId.H264:
                this.#configureH264(data);
                break;
            case ScrcpyVideoCodecId.H265:
                this.#configureH265(data);
                break;
        }
        this.#config = data;
    }

    #decode(packet: ScrcpyMediaStreamDataPacket) {
        if (this.#decoder.state !== "configured") {
            return;
        }

        // WebCodecs requires configuration data to be with the first frame.
        // https://www.w3.org/TR/webcodecs-avc-codec-registration/#encodedvideochunk-type
        let data: Uint8Array;
        if (this.#config !== undefined) {
            data = new Uint8Array(
                this.#config.byteLength + packet.data.byteLength,
            );
            data.set(this.#config, 0);
            data.set(packet.data, this.#config.byteLength);
            this.#config = undefined;
        } else {
            data = packet.data;
        }

        this.#decoder.decode(
            new EncodedVideoChunk({
                // Treat `undefined` as `key`, otherwise won't decode.
                type: packet.keyframe === false ? "delta" : "key",
                timestamp: 0,
                data,
            }),
        );
    }

    dispose() {
        cancelAnimationFrame(this.#animationFrameId);
        if (this.#decoder.state !== "closed") {
            this.#decoder.close();
        }
    }
}
