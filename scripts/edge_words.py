"""Edge neural TTS with word boundary timings.

Writes the mp3 and a JSON array of {"t": seconds, "d": seconds, "w": word}
so the editor can cut subtitles that follow the actual voice.

Usage: python edge_words.py <text file> <out mp3> <voice> <rate> <pitch> <out json>
"""

import asyncio
import json
import sys

import edge_tts


async def main() -> None:
    text_path, out_media, voice, rate, pitch, out_json = sys.argv[1:7]
    with open(text_path, "r", encoding="utf-8") as handle:
        text = handle.read().strip()
    if not text:
        raise SystemExit("empty narration")

    communicate = edge_tts.Communicate(
        text, voice, rate=rate, pitch=pitch, boundary="WordBoundary"
    )
    words = []
    with open(out_media, "wb") as audio:
        async for chunk in communicate.stream():
            kind = chunk.get("type")
            if kind == "audio":
                audio.write(chunk["data"])
            elif kind == "WordBoundary":
                words.append(
                    {
                        "t": round(chunk["offset"] / 10_000_000, 3),
                        "d": round(chunk["duration"] / 10_000_000, 3),
                        "w": chunk["text"],
                    }
                )

    with open(out_json, "w", encoding="utf-8") as handle:
        json.dump(words, handle)


if __name__ == "__main__":
    asyncio.run(main())
