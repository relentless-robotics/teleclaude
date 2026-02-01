
import whisper
import warnings
warnings.filterwarnings("ignore")

# Use base model for good accuracy/speed balance
# Will use GPU (CUDA) if available
model = whisper.load_model("base")
result = model.transcribe("C:/Users/Footb/Documents/Github/teleclaude-main/captcha-lab/solver/temp/audio_bba98e020c7b406c.wav", language="en", fp16=False)
print(result["text"].strip())
