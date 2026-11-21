# Docker infrastructure (agent)

Compose stack for optional **Speaches** (STT: **faster-distil-whisper-large-v3**). Chat titles no longer use Redis.

Voice defaults to the **browser** Web Speech API (`VOICE_STT_PROVIDER=browser`) — no Speaches required. Start this Speaches service only when you set `VOICE_STT_PROVIDER=speaches` in the host `.env` (the web reads providers from the API; no `NEXT_PUBLIC_` copy). Read-aloud (Kokoro) is the same with `VOICE_TTS_PROVIDER=speaches`.

**Ollama is not part of this compose file.** Chat stays on cloud via host `.env` (`OLLAMA_BASE_URL=https://ollama.com/v1`). Your existing Ollama container and model directory (e.g. `D:\ollama\models`) are never mounted, created, replaced, or deleted by `docker compose up` / `down` / `down -v`.

## What Compose owns vs leaves alone

| Path / service                                           | Owned by this compose?        |
| -------------------------------------------------------- | ----------------------------- |
| Speaches HF cache (`speaches-hf-cache` or Speaches bind) | Yes — speech models only      |
| Ollama models (e.g. `D:\ollama\models`)                  | **No — never referenced**     |
| Standalone `ollama` container on `:11434`                | **No — leave running as-is**  |
| Host `.env` `OLLAMA_*` for apps/api                      | **No — cloud chat unchanged** |

## Portability (open source)

Committed defaults use a **Docker named volume** (`speaches-hf-cache`). Works on **macOS, Linux, and Windows**.

| Layer                         | In git?             | Purpose                           |
| ----------------------------- | ------------------- | --------------------------------- |
| `docker-compose.yml`          | Yes                 | Portable defaults (named volumes) |
| `.env.docker.example`         | Yes                 | Documented optional overrides     |
| `.env.docker`                 | **No** (gitignored) | Your machine paths / ports        |
| `docker-compose.override.yml` | **No** (gitignored) | Optional personal binds           |

**Contributors:** `docker compose --profile cpu up -d` — no `.env.docker` required.

Optional Windows D: bind for Speaches only (never Ollama):

```env
SPEACHES_HF_CACHE_DIR=D:/agent/docker-data/speaches/hf-hub
```

Compose rule: a **bare name** → named volume; an **absolute path** → host bind mount.

## STT model choice

| Model                                                  | When                                             |
| ------------------------------------------------------ | ------------------------------------------------ |
| **`Systran/faster-distil-whisper-large-v3`** (default) | GPU dictation: best accuracy vs latency          |
| `Systran/faster-whisper-medium`                        | CPU-only fallback if distil is too heavy         |
| `Systran/faster-whisper-large-v3`                      | Avoid as default — often 2–4× slower than distil |

**One STT model.** Keep the same id in host `.env` as `SPEACHES_STT_MODEL`.

> The current Speaches image (`0.1.0`) does **not** read `PRELOAD_MODELS`; the list is kept for images that do. Install models with `POST /v1/models/<id>` (below). Weights land in the same HF cache (`SPEACHES_HF_CACHE_DIR`), so they survive `down` / `up`.
>
> Idle unload is Speaches' `WHISPER__TTL` (one setting for Whisper, Kokoro and Piper). Compose maps `SPEACHES_STT_MODEL_TTL` onto it; `-1` keeps models loaded.

## TTS model (read-aloud)

| Model | Size | Notes |
| --- | --- | --- |
| **`speaches-ai/Kokoro-82M-v1.0-ONNX-fp16`** | ~200 MB | English voices (e.g. `af_heart`), runs on GPU via onnxruntime-gpu in `latest-cuda` |

```bash
curl -X POST "http://127.0.0.1:8000/v1/models/speaches-ai%2FKokoro-82M-v1.0-ONNX-fp16"
```

Same server, same cache folder, same OpenAI-style API as STT: `POST /v1/audio/speech` with `{ model, input, voice, response_format }`.

**GPU check.** Speaches 0.1.0 picks Kokoro's ONNX device from an unordered set, so without a fixed seed it lands on CPU about half the time. The `gpu` service pins `PYTHONHASHSEED=0`, which orders CUDA first. On an RTX 3060 Ti a 134-character paragraph takes ~0.6 s on GPU vs ~1.8–2.7 s on CPU. After an image upgrade, re-check:

```bash
docker exec agent-speaches /home/ubuntu/speaches/.venv/bin/python -c "import onnxruntime as o; print(list(set(o.get_available_providers())-{'TensorrtExecutionProvider'})[0])"
# must print CUDAExecutionProvider
```

### Switch model / free old HF weights

Volume **path stays the same**; only remove old model dirs inside the cache:

```bash
docker compose --env-file .env.docker down

# Host bind example (Windows D:):
# rm -rf "D:/agent/docker-data/speaches/hf-hub/models--Systran--faster-whisper-medium"
# rm -rf "D:/agent/docker-data/speaches/hf-hub/models--Systran--faster-whisper-small"

docker compose --env-file .env.docker up -d
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8000/v1/models
# if distil missing:
curl -X POST "http://127.0.0.1:8000/v1/models/Systran%2Ffaster-distil-whisper-large-v3"
# if Kokoro missing (TTS):
curl -X POST "http://127.0.0.1:8000/v1/models/speaches-ai%2FKokoro-82M-v1.0-ONNX-fp16"
```

## Optional: Windows D: bind (Speaches only)

```powershell
New-Item -ItemType Directory -Force -Path D:\agent\docker-data\speaches\hf-hub
```

Do **not** set Speaches paths to `D:\ollama\models`.

## Start / stop

```bash
docker compose --profile cpu up -d
# or: docker compose --env-file .env.docker up -d

curl -s http://127.0.0.1:8000/health

# Stop stack — Ollama models dir is not involved
docker compose down
```

`down -v` only removes **this project’s** named volume (`speaches-hf-cache`). It cannot remove `D:\ollama\models` because that path is not in the compose file.

## Profiles: CPU vs GPU (Speaches)

| Profile | Service        | Image         | When                        |
| ------- | -------------- | ------------- | --------------------------- |
| `cpu`   | `speaches`     | `latest-cpu`  | Works today (slower)        |
| `gpu`   | `speaches-gpu` | `latest-cuda` | After Docker can use NVIDIA |

### Enable GPU (Windows + RTX, e.g. 3060 Ti)

Host GPU can work while Docker still cannot. Gate test:

```bash
nvidia-smi
# must show your GPU on Windows

docker run --rm --gpus all nvidia/cuda:12.0.0-base-ubuntu22.04 nvidia-smi
# must show the same GPU inside Docker — if this fails, stay on COMPOSE_PROFILES=cpu
```

If the Docker test fails (`libnvidia-ml.so.1` / empty reply):

1. Docker Desktop → **Settings → General** → use **WSL 2** engine.
2. **Settings → Resources → WSL integration** → enable your distro.
3. **Settings → Resources** → enable **GPU** / NVIDIA support if shown (wording varies by Desktop version).
4. Install/update [NVIDIA driver](https://www.nvidia.com/drivers) (you already have a working host driver).
5. **Apply & restart** Docker Desktop.
6. Re-run the `docker run --gpus all … nvidia-smi` gate test.

When the gate test passes, switch Speaches to GPU in `.env.docker`:

```env
COMPOSE_PROFILES=gpu
SPEACHES_TAG=latest-cuda
SPEACHES_WHISPER_COMPUTE_TYPE=float16
SPEACHES_PRELOAD_MODELS=["Systran/faster-distil-whisper-large-v3","speaches-ai/Kokoro-82M-v1.0-ONNX-fp16"]
```

Then:

```bash
docker compose --env-file .env.docker down
docker compose --env-file .env.docker up -d
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8000/v1/models
```

App `.env` stays `SPEACHES_STT_MODEL=Systran/faster-distil-whisper-large-v3`.

## App wiring (host-run API / web)

```env
VOICE_STT_PROVIDER=speaches
SPEACHES_BASE_URL=http://127.0.0.1:8000
SPEACHES_STT_MODEL=Systran/faster-distil-whisper-large-v3
VOICE_STT_LANGUAGE=en
VOICE_STT_PROMPT=agent, Speaches, Nx monorepo, Ollama, agent-core, RunManager, ChatInput
VOICE_TTS_PROVIDER=speaches
SPEACHES_TTS_MODEL=speaches-ai/Kokoro-82M-v1.0-ONNX-fp16
VOICE_TTS_VOICE=af_heart
# Keep chat on cloud — do not point OLLAMA_BASE_URL at Compose
```

If Speaches returns 404 “model not installed”:

```bash
curl -X POST "http://127.0.0.1:8000/v1/models/Systran%2Ffaster-distil-whisper-large-v3"
```

### Latency checklist

- One warm GPU request on a short clip should be **&lt; ~3 s** (first request after restart may download/load).
- Voice UI (Speaches) cuts whole utterances with Silero VAD in the browser (800 ms silence ends one, 25 s cap); Alt+A off still drains in-flight STT.
- If wall clock is still 9–10 s per phrase, confirm CUDA (`docker compose logs speaches`) and that only one STT model is installed.

## Useful commands

```bash
docker compose logs -f speaches
docker stats agent-speaches --no-stream
docker compose down
```

## RAM / VRAM note

Speaches **faster-distil-whisper-large-v3** is the default for productive dictation on GPU (`float16`). On CPU it is heavier than `medium` — raise Docker memory if preload OOMs, or temporarily set `SPEACHES_PRELOAD_MODELS` / `SPEACHES_STT_MODEL` to `Systran/faster-whisper-medium`. Ollama model dirs are never mounted by this stack.
