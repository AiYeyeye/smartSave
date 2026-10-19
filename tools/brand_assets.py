"""Rasterize the existing .zh-logo CSS geometry; no new logo system or remote images."""
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def generate(playwright, browser_path):
    browser = playwright.chromium.launch(executable_path=str(browser_path), headless=True)
    try:
        page = browser.new_page(viewport={'width': 1280, 'height': 800}, device_scale_factor=1)
        logo = '<div class="logo"><i></i></div>'
        css = '''*{box-sizing:border-box}body{margin:0;font-family:system-ui,'Microsoft YaHei',sans-serif;color:#17191e}
        .logo{position:relative;width:var(--size);height:var(--size);border-radius:30.77%;background:radial-gradient(120% 120% at 0% 0%,color-mix(in oklab,#5b5bd6 70%,white) 0%,transparent 60%),#5b5bd6}
        .logo i{position:absolute;left:30.77%;top:23.08%;width:38.46%;height:53.85%;background:#fff;opacity:.95;clip-path:polygon(0 0,100% 0,100% 100%,50% 72%,0 100%)}'''
        icons = ROOT / 'extension/public/icons'
        media = ROOT / '.local/private/store/media'
        icons.mkdir(parents=True, exist_ok=True)
        media.mkdir(parents=True, exist_ok=True)
        for size in [16, 32, 48, 128]:
            page.set_viewport_size({'width': size, 'height': size})
            page.set_content(f'<style>{css}:root{{--size:{size}px}}</style>{logo}')
            page.screenshot(path=str(icons / f'icon-{size}.png'), omit_background=True)
        for width, height, filename in [(440, 280, 'store-tile-440x280.png'), (1400, 560, 'store-marquee-1400x560.png')]:
            page.set_viewport_size({'width': width, 'height': height})
            page.set_content(f'''<style>{css}:root{{--size:{80 if width==440 else 120}px}}
              body{{width:100vw;height:100vh;background:#f4f5f7;display:flex;align-items:center;justify-content:center}}
              main{{display:flex;flex-direction:{'column' if width==440 else 'row'};align-items:center;gap:24px;text-align:{'center' if width==440 else 'left'}}}
              h1{{font-size:{32 if width==440 else 60}px;line-height:1.1;margin:0 0 14px}}p{{font-size:{15 if width==440 else 24}px;color:#555b66;margin:0}}
              </style><main>{logo}<div><h1>智栏 · Zhilan</h1><p>原生书签 · 本地搜索 · AI 辅助整理</p></div></main>''')
            page.screenshot(path=str(media / filename))
    finally:
        browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path, required=True)
    args = parser.parse_args()
    with sync_playwright() as p:
        generate(p, args.browser)
    print('Generated existing brand icons and store tiles')
