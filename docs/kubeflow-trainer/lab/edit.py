"""Cut the raw recording by marks: drop 'cut', keep 'keep' at 1x, speed up 'fast' to fit the target length."""
import json, subprocess, sys
TARGET = float(sys.argv[1]) if len(sys.argv) > 1 else 175.0
m = json.load(open('/tmp/kft/video/marks.json'))
video, marks = m['video'], m['marks']
dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).decode())
segs = []
for i, mk in enumerate(marks):
    if mk['kind'] == 'end':
        break
    end = marks[i + 1]['t'] if i + 1 < len(marks) else dur
    segs.append([mk['kind'], mk['t'], min(end, dur), mk['label']])
end_t = next((mk['t'] for mk in marks if mk['kind'] == 'end'), dur)
keep = sum(e - s for k, s, e, _ in segs if k == 'keep')
fast = sum(e - s for k, s, e, _ in segs if k == 'fast')
room = max(TARGET - keep, 6)
speed = max(4.0, min(24.0, fast / room)) if fast else 1
print(f'raw {dur:.1f}s  keep {keep:.1f}s  fast {fast:.1f}s -> x{speed:.1f}  est {keep + fast / speed:.1f}s')
parts, labels = [], []
for i, (k, s, e, lab) in enumerate(segs):
    if k == 'cut' or e - s < 0.05:
        continue
    f = 1 if k == 'keep' else speed
    parts.append(f'[0:v]trim=start={s:.2f}:end={e:.2f},setpts=(PTS-STARTPTS)/{f:.3f}[v{i}]')
    labels.append(f'[v{i}]')
fc = ';'.join(parts) + ';' + ''.join(labels) + f'concat=n={len(labels)}:v=1:a=0,fps=30,format=yuv420p[out]'
out = 'aif-notebook-training-demo.mp4'
subprocess.check_call(['ffmpeg', '-y', '-v', 'error', '-i', video, '-filter_complex', fc, '-map', '[out]',
                       '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', out])
print('wrote', out, subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).decode().strip(), 's')
