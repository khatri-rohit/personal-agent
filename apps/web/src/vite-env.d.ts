/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Self-hosted Silero VAD assets (default: the pinned CDN copy). */
  readonly VITE_VAD_ASSET_BASE?: string;
  /** Self-hosted onnxruntime-web wasm (default: matches the bundled runtime). */
  readonly VITE_ORT_WASM_BASE?: string;
}
