"""Capture actual production extension UI with synthetic bookmarks in a fresh profile.

Requires an existing Chromium, Python Playwright and optional FFmpeg. No download,
real bookmark access, provider credentials or AI response simulation is performed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from playwright.sync_api import expect, sync_playwright
from brand_assets import generate

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / 'docs/media'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path, required=True)
    parser.add_argument('--ffmpeg', type=Path)
    args = parser.parse_args()
    if not args.browser.is_file() or (args.ffmpeg and not args.ffmpeg.is_file()):
        raise SystemExit('Pass existing browser / FFmpeg executable paths')
    manifest_file = ROOT / 'extension/dist/manifest.json'
    if not manifest_file.exists():
        raise SystemExit('Build production extension assets first')
    work = Path(tempfile.mkdtemp(prefix='zhilan-release-media-'))
    extension = work / 'extension'
    shutil.copytree(ROOT / 'extension/dist', extension)
    screenshots = MEDIA / 'screenshots'
    screenshots.mkdir(parents=True, exist_ok=True)
    errors, network = [], []
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(work / 'profile'), executable_path=str(args.browser), headless=True,
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
                  '--disable-background-networking', '--lang=zh-CN'],
            viewport={'width': 1280, 'height': 800}, reduced_motion='reduce', locale='zh-CN')
        try:
            context.route('https://**/*', lambda route: route.abort())
            context.on('request', lambda request: network.append(request.url) if request.url.startswith(('https://', 'http://')) else None)
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
            extension_id = worker.url.split('/')[2]
            # Synthetic native bookmarks, only in the newly-created disposable profile.
            seeded = worker.evaluate('''async () => {
              const bar = (await chrome.bookmarks.getTree())[0].children[0].id;
              const groups = [
                ['开发与技术', [['MDN · Web 开发文档','mdn'],['React · 组件与交互','react'],['TypeScript · 类型系统','typescript'],['GitHub · 项目协作','github']]],
                ['设计与灵感', [['Figma · 设计协作','figma'],['流程图 · diagrams.net','diagrams'],['配色与排版参考','colors']]],
                ['学习与阅读', [['浏览器扩展开发入门','extensions'],['每周阅读清单','reading'],['学习笔记与方法','notes']]],
                ['工作与效率', [['项目计划与待办','planning'],['团队知识库','knowledge'],['常用工具导航','tools']]]
              ];
              const folders = [];
              for (const [title, items] of groups) {
                const folder = await chrome.bookmarks.create({parentId:bar,title}); folders.push(folder.id);
                for (const [title, slug] of items) await chrome.bookmarks.create({parentId:folder.id,title,url:`https://demo.example.test/${slug}`});
              }
              return {folders,count:groups.reduce((n,g)=>n+g[1].length,0)};
            }''')
            page = context.pages[0] if context.pages else context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            base = f'chrome-extension://{extension_id}/options/index.html'
            page.goto(base + '#browse')
            for title in ['开发与技术', '设计与灵感', '学习与阅读', '工作与效率']:
                folder = page.get_by_role('button', name=title, exact=True)
                expect(folder).to_be_visible()
                if folder.get_attribute('aria-expanded') == 'false':
                    folder.click()
            expect(page.get_by_role('button', name='MDN · Web 开发文档', exact=True)).to_be_visible()
            page.screenshot(path=str(screenshots / '01-bookmarks.png'), full_page=False, animations='disabled')
            search = page.get_by_role('searchbox')
            search.fill('流程图')
            expect(page.get_by_role('button', name='流程图 · diagrams.net', exact=True)).to_be_visible()
            page.screenshot(path=str(screenshots / '02-search.png'), full_page=False, animations='disabled')
            for route, name, heading in [
                ('organize', '03-organize', 'AI 整理'),
                ('export', '04-export', '导出与备份'),
                ('privacy', '05-privacy', '隐私与规则'),
            ]:
                page.goto(base + '#' + route)
                expect(page.get_by_role('heading', name=heading, exact=True).first).to_be_visible()
                page.wait_for_timeout(700)
                page.screenshot(path=str(screenshots / f'{name}.png'), full_page=False, animations='disabled')
            browser_version = context.browser.version
        finally:
            context.close()
        # Record a clean local walkthrough using the same synthetic native profile.
        context = p.chromium.launch_persistent_context(
            str(work / 'profile'), executable_path=str(args.browser), headless=True,
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking', '--lang=zh-CN'],
            viewport={'width': 1280, 'height': 800}, reduced_motion='reduce', locale='zh-CN',
            record_video_dir=str(work / 'video'), record_video_size={'width': 1280, 'height': 800})
        try:
            context.route('https://**/*', lambda route: route.abort())
            context.on('request', lambda request: network.append(request.url) if request.url.startswith(('https://', 'http://')) else None)
            page = context.pages[0] if context.pages else context.new_page()
            video = page.video
            page.goto(base + '#browse')
            expect(page.get_by_role('searchbox')).to_be_visible()
            page.wait_for_timeout(4000)
            page.get_by_role('searchbox').fill('流程图')
            page.wait_for_timeout(5000)
            page.get_by_role('searchbox').fill('')
            page.wait_for_timeout(1500)
            for route in ['organize', 'export', 'privacy', 'ai-services']:
                page.goto(base + '#' + route)
                page.wait_for_timeout(5000)
            page.goto(base + '#browse')
            page.wait_for_timeout(3000)
        finally:
            context.close()
        recorded = Path(video.path())
        if args.ffmpeg:
            converted = subprocess.run([str(args.ffmpeg), '-y', '-i', str(recorded), '-an', '-c:v', 'libx264',
                                       '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                                       str(MEDIA / 'zhilan-quick-tour.mp4')], capture_output=True)
            if converted.returncode:
                shutil.copy2(recorded, MEDIA / 'zhilan-quick-tour.webm')
                raise SystemExit('MP4 conversion failed; use a full FFmpeg build with libx264. WebM retained in docs/media.')
        else:
            shutil.copy2(recorded, MEDIA / 'zhilan-quick-tour.webm')
        generate(p, args.browser)
    result = {
        'capturedAtUnix': int(time.time()), 'viewport': [1280, 800], 'browser': browser_version,
        'source': 'Unmodified production extension assets, native synthetic bookmarks, disposable profile',
        'bookmarkCount': seeded['count'], 'realCredentials': False, 'simulatedAiResults': False,
        'externalHttpRequests': len(network), 'pageErrors': errors,
        'productionWorkerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
        'profile': 'Temporary, no daily profile accessed; not distributed',
        'files': {path.relative_to(MEDIA).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in sorted(MEDIA.rglob('*')) if path.is_file() and path.suffix in {'.png', '.mp4', '.webm'}},
    }
    (work / 'capture-evidence.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if errors or network:
        raise SystemExit('Unexpected page errors or external requests; inspect local capture evidence')


if __name__ == '__main__':
    main()
