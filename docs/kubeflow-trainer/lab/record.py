"""Record the demo: admin settings in Rancher (Workloads > Scheduling), the user procedure, and an
end-to-end run from a local Jupyter. Writes the raw video and a marks.json of segments to speed up."""
import json, pathlib, time
from playwright.sync_api import sync_playwright, expect

HOME = pathlib.Path.home()
ADMIN = HOME.joinpath('.config/aif/admin.token').read_text().strip()
BASE = 'https://localhost:8443'
SCHED = f'{BASE}/dashboard/c/local/suseai/aif-scheduling'
JLAB = 'http://127.0.0.1:8891/lab/tree/local-train.ipynb'
OUT = pathlib.Path('/tmp/kft/video/raw'); OUT.mkdir(parents=True, exist_ok=True)

OVERLAY = r"""
(() => {
  if (window.__demo) return; window.__demo = true;
  const css = `
  #demo-cap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:1200px;
    background:rgba(12,20,40,.88);color:#fff;font:600 22px/1.35 -apple-system,'Segoe UI',sans-serif;padding:12px 22px;
    border-radius:10px;border-left:6px solid #2453ff;box-shadow:0 6px 24px rgba(0,0,0,.35);transition:opacity .25s;opacity:0}
  #demo-cap small{display:block;font-weight:400;font-size:16px;opacity:.85;margin-top:2px}
  #demo-cur{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-3px 0 0 -3px;pointer-events:none;
    transition:left .45s ease,top .45s ease;left:800px;top:450px}
  #demo-cur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
  #demo-cur.click::after{content:'';position:absolute;left:-9px;top:-9px;width:28px;height:28px;border-radius:50%;
    border:3px solid #2453ff;animation:demo-ping .45s ease-out}
  @keyframes demo-ping{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
  #demo-card{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;justify-content:center;
    padding:0 140px;background:linear-gradient(135deg,#0b1a3a 0%,#132a5e 60%,#2453ff 160%);color:#fff;
    font-family:-apple-system,'Segoe UI',sans-serif}
  #demo-card h1{color:#fff !important;font-size:54px;margin:0 0 18px;font-weight:700;letter-spacing:-.5px}
  #demo-card p{color:#fff !important;font-size:26px;margin:6px 0;opacity:.92;max-width:1250px;line-height:1.4}
  #demo-card .kick{font-size:18px;letter-spacing:3px;text-transform:uppercase;color:#9fb3ff;margin-bottom:22px}
  #demo-card ol, #demo-card li{color:#fff !important;font-size:25px;line-height:1.7;margin:10px 0 0 4px;padding-left:28px}
  #demo-ff{position:fixed;top:18px;right:22px;z-index:2147483647;background:rgba(12,20,40,.85);color:#fff;
    font:600 18px -apple-system,sans-serif;padding:6px 14px;border-radius:18px;display:none}
  #demo-card code{background:rgba(255,255,255,.12);padding:2px 8px;border-radius:5px;font-size:22px}`;
  const add = () => {
    if (!document.body) return setTimeout(add, 50);
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement('div'); c.id = 'demo-cap'; document.body.appendChild(c);
    const k = document.createElement('div'); k.id = 'demo-cur';
    k.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="#fff" stroke="#111" stroke-width="1.5"/></svg>';
    document.body.appendChild(k);
    const f = document.createElement('div'); f.id = 'demo-ff'; f.textContent = '⏩ fast-forward'; document.body.appendChild(f);
    if (window.__demoState && window.__demoState.ff) f.style.display = 'block';
    if (window.__demoState) { window.__cap(window.__demoState.cap || ''); k.style.left = window.__demoState.x + 'px'; k.style.top = window.__demoState.y + 'px'; }
  };
  window.__cap = (t, sub) => { const c = document.getElementById('demo-cap'); if (!c) return;
    if (!t) { c.style.opacity = 0; return; } c.innerHTML = t + (sub ? `<small>${sub}</small>` : ''); c.style.opacity = 1; };
  window.__ff = (on) => { const f = document.getElementById('demo-ff'); if (f) f.style.display = on ? 'block' : 'none'; };
  window.__move = (x, y) => { const k = document.getElementById('demo-cur'); if (k) { k.style.left = x + 'px'; k.style.top = y + 'px'; } };
  window.__ping = () => { const k = document.getElementById('demo-cur'); if (!k) return; k.classList.remove('click'); void k.offsetWidth; k.classList.add('click'); };
  window.__card = (html) => { let d = document.getElementById('demo-card'); if (!html) { if (d) d.remove(); return; }
    if (!d) { d = document.createElement('div'); d.id = 'demo-card'; document.body.appendChild(d); } d.innerHTML = html; };
  add();
})();
"""

marks = []
T0 = None
PAGE = None


def now():
    return time.monotonic() - T0


def mark(kind, label=''):
    marks.append({'t': round(now(), 2), 'kind': kind, 'label': label})
    json.dump({'video': None, 'marks': marks}, open('/tmp/kft/video/marks.partial.json', 'w'), indent=1)
    if PAGE is not None:
        on = kind == 'fast'
        PAGE.evaluate('on => { window.__ff && window.__ff(on); window.__demoState = Object.assign(window.__demoState || {}, {ff: on}); }', on)


class Demo:
    def __init__(self, page):
        self.p = page
        self.cap_text = ''
        self.x, self.y = 800, 450

    def wait(self, ms):
        self.p.wait_for_timeout(ms)

    def _state(self):
        self.p.evaluate('s => { window.__demoState = Object.assign(window.__demoState || {}, s); }', {'cap': self.cap_text, 'x': self.x, 'y': self.y})

    def cap(self, text, sub=None, hold=0):
        self.cap_text = text
        self.p.evaluate('([t, s]) => window.__cap && window.__cap(t, s)', [text, sub])
        self._state()
        if hold:
            self.wait(hold)

    def card(self, html, hold):
        self.p.evaluate('h => window.__card(h)', html)
        self.wait(hold)
        self.p.evaluate('() => window.__card(null)')

    def point(self, loc):
        loc.scroll_into_view_if_needed()
        b = loc.bounding_box()
        self.x, self.y = b['x'] + min(b['width'] / 2, 60), b['y'] + b['height'] / 2
        self.p.evaluate('([x, y]) => window.__move(x, y)', [self.x, self.y])
        self._state()
        self.wait(550)

    def click(self, loc, after=600):
        self.point(loc)
        self.p.evaluate('() => window.__ping()')
        loc.click()
        self.wait(after)

    def type(self, loc, text):
        self.click(loc, after=200)
        loc.fill('')
        loc.press_sequentially(text, delay=70)
        self.wait(300)

    def goto(self, url, settle=6000):
        self.p.goto(url, wait_until='load', timeout=90000)
        self.wait(settle)
        self.p.evaluate('([t]) => window.__cap && window.__cap(t)', [self.cap_text])


def tab(d, name):
    d.click(d.p.get_by_role('tab', name=name, exact=True).first, after=2500)


def select(d, label_text, option):
    box = d.p.locator('.labeled-select', has_text=label_text).first
    d.click(box, after=500)
    d.click(d.p.locator('.vs__dropdown-menu li', has_text=option).first, after=500)


def main():
    global T0, PAGE
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={'width': 1600, 'height': 900}, ignore_https_errors=True,
                             record_video_dir=str(OUT), record_video_size={'width': 1600, 'height': 900})
        ctx.add_cookies([{'name': 'R_SESS', 'value': ADMIN, 'domain': 'localhost', 'path': '/', 'secure': True,
                          'httpOnly': True, 'sameSite': 'Lax'}])
        ctx.add_init_script(OVERLAY)
        page = ctx.new_page()
        PAGE = page
        T0 = time.monotonic()
        d = Demo(page)

        # warm up Rancher off-camera (cut later): load the dashboard and the extension once
        mark('cut', 'warmup')
        d.goto(SCHED, settle=12000)

        # ---- title
        mark('keep', 'title')
        d.cap('')
        d.card('<div class="kick">SUSE AI Factory · prototype</div><h1>Notebook training, governed by AI Factory</h1>'
               '<p>Data scientists submit training jobs from Jupyter.</p>'
               '<p>Admins set queues, quotas and access in Rancher.</p>'
               '<p>Kubeflow Trainer runs them; the KAI scheduler places them.</p>', 6500)

        # ---- admin settings
        d.cap('Admin: SUSE AI Factory → Workloads → Scheduling', 'a new menu in the AI Factory extension')
        d.goto(SCHED, settle=4000)
        try:
            d.point(page.get_by_text('Scheduling', exact=True).first)
        except Exception:
            pass
        d.wait(1800)

        tab(d, 'Readiness')
        d.cap('Readiness: everything the cluster needs, checked', 'KAI Scheduler · Kubeflow Trainer · JobSet · AI Factory runtimes · roles', hold=6000)

        tab(d, 'Queues & Quotas')
        d.cap('Queues & Quotas: each project gets a KAI queue with a GPU quota', hold=3500)
        d.click(page.get_by_role('button', name='Add queue'))
        d.type(page.locator('.labeled-input', has_text='Name').locator('input').first, 'team-b')
        select(d, 'Parent queue', 'aif-root')
        d.type(page.locator('.labeled-input', has_text='GPU quota').locator('input').first, '1')
        d.click(page.get_by_role('button', name='Save'), after=2500)
        d.cap('New queue team-b: 1 guaranteed GPU, can borrow idle ones', hold=3500)

        tab(d, 'Projects')
        d.cap('Projects: enable training on a namespace and choose its queue',
              'Notebook access and the AI Trainer role are granted here too', hold=6000)
        d.point(page.get_by_text('AI Trainers').first)
        d.cap('AI Trainers: who may submit runs in this project', hold=3500)

        tab(d, 'Runtimes')
        d.cap('Runtimes: the compute profiles users choose from', 'GPU share · whole GPUs · CPU, each with its limits', hold=5500)

        # ---- procedure
        d.cap('')
        d.card('<div class="kick">The data scientist</div><h1>From a local Jupyter, no kubeconfig</h1><ol>'
               '<li>In Rancher, create an API key (Account &amp; API Keys)</li>'
               '<li><code>export RANCHER_URL=… RANCHER_TOKEN=…</code></li>'
               '<li>Open the notebook, run the cells</li></ol>'
               '<p style="margin-top:22px">Every call goes through Rancher, with the user\'s own rights.</p>', 7500)

        # ---- notebook
        d.cap('Local Jupyter, signed in to Rancher as trainer1 with an API key')
        d.goto(JLAB, settle=5000)
        no = page.get_by_role('button', name='No')
        if no.count():
            no.first.click()
        if page.locator('.jp-DirListing').first.is_visible():
            page.keyboard.press('Meta+b')  # hide the file browser (Accel+B)
        d.wait(800)
        cells = page.locator('.jp-Notebook .jp-Cell')
        d.click(cells.nth(1).locator('.jp-InputArea-editor'), after=300)
        page.keyboard.press('Escape')

        def run_cell(wait_text=None, timeout=300000):
            page.keyboard.press('Shift+Enter')
            if wait_text:
                expect(page.locator('.jp-Notebook')).to_contain_text(wait_text, timeout=timeout)
            else:
                d.wait(700)
                page.wait_for_function("""() => {
                  const busy = [...document.querySelectorAll('.jp-InputPrompt')].some(e => e.textContent.includes('[*]'));
                  const ind = document.querySelector('.jp-Notebook-ExecutionIndicator');
                  return !busy && (!ind || ind.getAttribute('data-status') !== 'busy');
                }""", timeout=timeout)
            d.wait(600)

        mark('fast', 'pip')
        run_cell()                          # %pip install
        mark('keep', 'connect')
        page.keyboard.press('Shift+Enter')  # markdown "1. Connect"
        d.cap('Connect: Rancher URL + API key, through Rancher\'s cluster proxy')
        run_cell()                          # settings cell
        run_cell('aif-share-8g', 60000)     # client + list runtimes
        d.cap('The runtimes trainer1 can use, read with trainer1\'s Rancher rights', hold=4000)
        page.keyboard.press('Shift+Enter')  # markdown "2."
        d.cap('A small PyTorch model; it runs on the cluster, not on the laptop')
        run_cell()                          # def train
        d.wait(2500)
        page.keyboard.press('Shift+Enter')  # markdown "3."
        d.cap('Submit to the project\'s KAI queue (namespace_queue)')
        run_cell('submitted', 60000)
        d.wait(2500)
        page.keyboard.press('Control+s')
        d.wait(1000)

        # ---- admin view of the live run
        d.cap('Admin view: the run appears in Training Jobs')
        d.goto(SCHED, settle=4000)
        tab(d, 'Training Jobs')
        first = page.locator('table.grid:visible tbody tr').first
        d.point(first)
        mark('fast', 'wait-running')
        page.wait_for_function("() => { const t = [...document.querySelectorAll('table.grid')].find(x => x.offsetParent); return /Running|Complete/.test(t?.querySelector('tbody tr')?.textContent || ''); }", timeout=300000)
        mark('keep', 'running')
        d.cap('Placed by KAI in queue aif-submit, on the aif-cpu runtime', hold=2000)
        d.click(first.locator('a').first, after=1500)
        d.cap('Its pod, the scheduler that placed it (kai-scheduler), the node', hold=4500)

        # ---- back to the notebook for the result
        d.cap('Back in the notebook: wait for the run and print its log')
        d.goto(JLAB, settle=5000)
        if page.locator('.jp-DirListing').first.is_visible():
            page.keyboard.press('Meta+b')
        d.wait(500)
        follow = page.locator('.jp-Notebook .jp-Cell.jp-CodeCell').last
        d.click(follow.locator('.jp-InputArea-editor'), after=300)
        page.keyboard.press('Escape')
        mark('fast', 'training')
        page.keyboard.press('Shift+Enter')
        expect(page.locator('.jp-Notebook')).to_contain_text('saved /outputs/spiral-mlp.pt', timeout=600000)
        mark('keep', 'result')
        page.locator('.jp-Notebook').get_by_text('epoch 300').first.scroll_into_view_if_needed()
        d.cap('Trained on the cluster: test accuracy 0.99, model saved to the run\'s volume', hold=6500)

        # ---- admin: complete + log
        d.cap('Training Jobs: Complete. Logs, suspend, resume and delete from the UI')
        d.goto(SCHED, settle=4000)
        tab(d, 'Training Jobs')
        first = page.locator('table.grid:visible tbody tr').first
        d.click(first.locator('a').first, after=1200)
        d.click(page.locator('table.grid:visible tr.sub a', has_text='log').first, after=3500)
        d.wait(3500)

        # ---- end
        d.cap('')
        d.card('<div class="kick">Summary</div><h1>Notebooks submit. AI Factory governs.</h1>'
               '<p>KAI queues and quotas per project · Kubeflow Trainer runtimes · admission policy for every job</p>'
               '<p>Admins in Rancher (Workloads → Scheduling) · users in Jupyter with a Rancher API key</p>'
               '<p style="opacity:.7;font-size:20px;margin-top:28px">Next: JupyterHub for multi-user notebooks</p>', 6500)
        mark('end')

        video = page.video.path()
        ctx.close(); br.close()
        json.dump({'video': str(video), 'marks': marks}, open('/tmp/kft/video/marks.json', 'w'), indent=1)
        print('video', video)
        print(json.dumps(marks, indent=1))


if __name__ == '__main__':
    import traceback  # DEBUG_SHOT
    try:
        main()
    except Exception:
        tb = traceback.extract_tb(__import__('sys').exc_info()[2])
        print('FAILED at', [f'{f.lineno}: {f.line}' for f in tb if f.filename.endswith('record.py')][-1])
        if PAGE is not None:
            PAGE.screenshot(path='/tmp/kft/video/fail.png')
        print(json.dumps(marks[-3:]))
