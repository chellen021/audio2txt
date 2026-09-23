import gradio as gr
import spaces
import torch
from transformers import pipeline

MODEL = "openai/whisper-large-v3-turbo"

pipe = pipeline(
    "automatic-speech-recognition",
    model=MODEL,
    torch_dtype=torch.float16,
    device="cuda",
)


@spaces.GPU(duration=60)
def transcribe(audio_path, language, initial_prompt):
    generate_kwargs = {"task": "transcribe"}
    if language:
        generate_kwargs["language"] = language
    if initial_prompt:
        generate_kwargs["prompt_ids"] = torch.tensor(
            pipe.tokenizer.get_prompt_ids(initial_prompt), device="cuda"
        )
    out = pipe(
        audio_path,
        chunk_length_s=30,
        batch_size=8,
        return_timestamps=True,
        generate_kwargs=generate_kwargs,
    )
    segments = []
    for chunk in out.get("chunks", []):
        start, end = chunk["timestamp"]
        segments.append({"start": start, "end": end, "text": chunk["text"]})
    text = out["text"]
    if initial_prompt and text.lstrip().startswith(initial_prompt):
        text = text.lstrip()[len(initial_prompt):]
    return {"text": text.strip(), "segments": segments}


demo = gr.Interface(
    fn=transcribe,
    inputs=[
        gr.File(label="音频", type="filepath"),
        gr.Textbox(label="语言代码（留空自动识别）"),
        gr.Textbox(label="提示词（可选）"),
    ],
    outputs=gr.JSON(label="结果"),
    title="audio2txt Whisper",
    api_name="transcribe",
    # 每小时清理一次超过 1 小时的上传文件，音频不长期留在服务器上
    delete_cache=(3600, 3600),
)

demo.queue(default_concurrency_limit=4).launch()
