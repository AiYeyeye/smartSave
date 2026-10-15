"""Opt-in production privacy/rules/diagnostics acceptance; isolated synthetic local data only."""
import argparse
import json
from pathlib import Path
import sys
import tempfile
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated synthetic preference acceptance')
    raise SystemExit(0)
extension = Path(__file__).resolve().parents[2] / 'dist'
root = Path(tempfile.mkdtemp(prefix='zhilan-preferences-locale-'))

with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
        '--disable-background-networking'], viewport={'width': 340, 'height': 960}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        preferences = context.new_page()
        preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        preferences.get_by_label('语言', exact=True).select_option('en')
        fixture = worker.evaluate("""async () => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const a=await chrome.bookmarks.create({parentId:bar,title:'隐私 {id}'});
          const b=await chrome.bookmarks.create({parentId:bar,title:'确认规则 {host}'});
          const installationId=(await chrome.storage.local.get('installationId')).installationId;
          const ref=id=>({installationId,nativeId:id,kind:'folder'});
          const body=JSON.stringify({title:'清空 {title}',url:'https://diagnostic-locale.test/'+('long-path-'.repeat(30))});
          const entry={t:Date.now(),src:'synthetic',event:'response-body',detail:{callId:'synthetic-call',attempt:1,body,truncated:false}};
          const receipt={id:'synthetic-receipt',bookmarkId:'synthetic-only',title:'最近的原生收藏',url:'https://diagnostic-locale.test/',at:Date.now(),status:'kept',fromParentId:bar,fromIndex:0,fromPath:'隐私 {id}',model:'清空 {model}',timing:{totalMs:1200,prepareMs:200,applyMs:100,model:{ms:900,attempts:1,streaming:false,validationMs:50}}};
          await chrome.storage.local.set({siteRules:{version:1,rules:[{host:'rule.example.test',folder:ref(a.id),includeSubdomains:false}]},debugSettings:{enabled:false},debugTrail:[entry],nativeSaveReceipts:[receipt]});
          return {a:a.id,b:b.id,body,entry,receipt};
        }""")
        before_tree = worker.evaluate('()=>chrome.bookmarks.getTree()')
        read_settings = "async()=> (await chrome.storage.local.get(['modelSecurity','siteRules','debugSettings','debugTrail','nativeSaveReceipts']))"
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#privacy')
        privacy = page.get_by_role('region', name='Privacy', exact=True)
        expect(privacy.get_by_role('checkbox', name='Send full URLs (including query parameters and fragments)', exact=True)).to_be_checked()
        before = worker.evaluate(read_settings)
        privacy.get_by_role('checkbox', name='Send full URLs (including query parameters and fragments)', exact=True).uncheck()
        privacy.get_by_role('checkbox', name='Use page content (explicit saves only)', exact=True).check()
        privacy.get_by_role('checkbox', name=f'隐私 {{id}}（{fixture["a"]}）', exact=True).check()
        page.get_by_role('button', name='Edit rule.example.test', exact=True).click()
        page.get_by_label('Rule destination folder', exact=True).select_option(fixture['b'])
        page.get_by_role('checkbox', name='Include subdomains', exact=True).check()
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_role('checkbox', name='正文辅助（仅主动收藏）', exact=True)).to_be_checked()
        expect(page.get_by_label('规则目标目录', exact=True)).to_have_value(fixture['b'])
        preferences.get_by_label('语言', exact=True).select_option('en')
        expect(page.get_by_role('checkbox', name='Include subdomains', exact=True)).to_be_checked()
        assert worker.evaluate(read_settings) == before
        geometry = []

        def capture(surface):
            for width in [320, 340, 480, 1024]:
                page.set_viewport_size({'width': width, 'height': 960})
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                size = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert size['scroll'] <= width + 1, (surface, size)
                if surface == 'diagnostics':
                    bounds = page.locator('.debug-list').evaluate('(element)=>({width:element.clientWidth,scroll:element.scrollWidth})')
                    assert bounds['scroll'] <= bounds['width'] + 1, bounds
                    body_bounds = page.locator('.debug-detail pre').bounding_box()
                    assert body_bounds and body_bounds['x'] >= 0 and body_bounds['x'] + body_bounds['width'] <= width, body_bounds
                geometry.append({'surface': surface, **size})
                page.screenshot(path=str(root / f'{surface}-{width}.png'), full_page=True)

        capture('privacy-and-rule-drafts')
        page.get_by_role('button', name='Save privacy settings', exact=True).click()
        expect(page.get_by_text('Privacy settings saved. Browsing works without a configured model.', exact=True)).to_be_visible()
        page.get_by_role('button', name='Confirm rule changes', exact=True).click()
        expect(page.get_by_text('Rule saved. No automatic save is triggered.', exact=True)).to_be_visible()
        saved = worker.evaluate(read_settings)
        assert saved['modelSecurity']['settings']['privacy'] == {'fullUrl':False,'bodyEnabled':True,'excludedFolders':[{'installationId':saved['siteRules']['rules'][0]['folder']['installationId'],'nativeId':fixture['a'],'kind':'folder'}]}
        assert saved['siteRules']['rules'][0]['folder']['nativeId'] == fixture['b']
        assert saved['siteRules']['rules'][0]['includeSubdomains'] is True
        page.goto(f'chrome-extension://{extension_id}/options/index.html#debug')
        expect(page.get_by_role('heading', name='Recent browser bookmark saves', exact=True)).to_be_visible()
        expect(page.get_by_text('清空 {model}', exact=True)).to_be_visible()
        expect(page.get_by_text('Total time: median 1.20s · P90 1.20s (samples: 1)', exact=True)).to_be_visible()
        page.get_by_text('View response body', exact=True).click()
        expect(page.locator('.debug-detail pre')).to_have_text(fixture['body'])
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_text('查看响应正文', exact=True).locator('..')).to_have_attribute('open', '')
        preferences.get_by_label('语言', exact=True).select_option('en')
        expect(page.locator('.debug-detail pre')).to_be_visible()
        assert worker.evaluate(read_settings) == saved
        capture('diagnostics')
        page.get_by_role('switch', name='Enable Debug logs', exact=True).check()
        expect(page.get_by_role('switch', name='Enable Debug logs', exact=True)).to_be_checked()
        page.get_by_role('button', name='Clear', exact=True).click()
        expect(page.get_by_text('Enabled, with no records yet. Save a webpage or test a connection.', exact=True)).to_be_visible()
        final = worker.evaluate(read_settings)
        assert final['debugSettings']['enabled'] is True and final['debugTrail'] == []
        assert final['nativeSaveReceipts'] == [fixture['receipt']]
        assert final['siteRules'] == saved['siteRules'] and final['modelSecurity'] == saved['modelSecurity']
        assert worker.evaluate('()=>chrome.bookmarks.getTree()') == before_tree
        result = {'status':'PASS','browser':context.browser.version,'evidence':str(root),'geometry':geometry,
                  'scope':'Unmodified production extension, fresh profile. Synthetic folders, rule, receipt and diagnostic body. Cross-document drafts, explicit privacy/rule writes, diagnostic opt-in and clear, unchanged native tree. No model/provider calls; clipboard verified separately in component tests.'}
        (root / 'results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result),flush=True)
    except Exception:
        print('EVIDENCE='+str(root),flush=True)
        for index,page in enumerate(context.pages):
            print(page.url,page.locator('body').inner_text()[-6000:],flush=True)
            page.screenshot(path=str(root / f'failure-{index}.png'),full_page=True)
        raise
    finally:
        context.close()
