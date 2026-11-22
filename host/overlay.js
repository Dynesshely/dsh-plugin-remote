/**
 * The overlay injected into every proxied document.
 *
 * It adds two things the desktop interface knows nothing about: a way back to the plugin page, and a split view that
 * shows the desktop interface and the remote-control page side by side with a draggable divider — the way a before
 * and after comparison is usually presented.
 *
 * Why the iframe fills the viewport instead of being sized to half of it: a split comparison only means anything if
 * both sides lay out at the size they would normally have. A half-width iframe would reflow its page into a shape
 * the reader never sees in practice, and the two halves would disagree about where anything is. The iframe is
 * therefore always viewport-sized and clipped; only which half survives changes.
 *
 * Nothing here depends on the host page's markup, class names or framework. It is one inline script and a few
 * absolutely positioned nodes behind the maximum z-index, so a DSH upgrade cannot break it by changing a selector.
 */

/** Depth used by the injected nodes; above anything the host draws, including its own dialogs. */
const Z = 2147483000

/**
 * @returns the markup and script appended to every proxied document.
 *
 * Kept as one string because it must arrive with the document: fetching a second file would add a round trip to a
 * page that already has to boot a large app, and would fail offline in a way that looks like a broken page.
 */
export function overlayMarkup () {
  return `
<a id="rc-back" href="/remote/" title="返回远程控制 / Back to remote control" data-rc="back"
   style="position:fixed;right:16px;bottom:16px;z-index:${Z};display:inline-flex;align-items:center;gap:7px;padding:9px 14px;border-radius:9999px;background:rgba(18,18,20,0.82);color:#fff;font:500 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;text-decoration:none;letter-spacing:0.01em;box-shadow:0 6px 20px rgba(0,0,0,0.38);border:1px solid rgba(255,255,255,0.16);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);cursor:pointer">
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
  <span>远程控制 · Remote</span>
</a>

<!-- The split surface. Present in the DOM from the start so switching modes costs one style change, not a rebuild. -->
<div id="rc-split" data-rc="split" aria-hidden="true"
     style="position:fixed;inset:0;z-index:${Z - 10};display:none;pointer-events:none">
  <iframe id="rc-frame" data-rc="frame" src="about:blank" title="Remote control"
          style="position:absolute;inset:0;width:100%;height:100%;border:0;background:#0b0b0d;pointer-events:auto"></iframe>
  <div id="rc-handle" data-rc="handle" role="separator" aria-orientation="vertical" tabindex="0"
       style="position:absolute;pointer-events:auto;touch-action:none;background:rgba(140,140,150,0.35);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)">
    <div id="rc-grip" data-rc="grip" title="拖拽调整比例，右键打开视图菜单 / Drag to resize, right-click for view options"
         style="position:absolute;display:flex;align-items:center;justify-content:center;background:rgba(18,18,20,0.92);border:1px solid rgba(255,255,255,0.22);border-radius:9999px;box-shadow:0 4px 16px rgba(0,0,0,0.45);color:#fff">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6-6 6 6 6"/><path d="m15 6 6 6-6 6"/></svg>
    </div>
  </div>
</div>

<!-- The menu. Right-clicking the pill opens it instead of the browser's own. -->
<div id="rc-menu" data-rc="menu" role="menu" aria-hidden="true"
     style="position:fixed;z-index:${Z + 1};display:none;min-width:210px;padding:6px;border-radius:14px;background:rgba(24,24,27,0.94);border:1px solid rgba(255,255,255,0.14);box-shadow:0 12px 36px rgba(0,0,0,0.5);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font:500 12.5px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#e8e8ea">
  <div style="padding:6px 10px 8px;font-size:11px;letter-spacing:0.04em;color:rgba(232,232,234,0.5)">视图 · View</div>
  <button type="button" data-rc-mode="off"    role="menuitemradio" aria-checked="true"  style="display:flex;width:100%;align-items:center;gap:8px;padding:8px 10px;border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer"><span data-rc-dot style="width:12px;text-align:center;color:#7c8cff"></span><span style="flex:1">仅反代页面</span></button>
  <button type="button" data-rc-mode="vertical" role="menuitemradio" aria-checked="false" style="display:flex;width:100%;align-items:center;gap:8px;padding:8px 10px;border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer"><span data-rc-dot style="width:12px;text-align:center;color:#7c8cff"></span><span style="flex:1">垂直切分</span></button>
  <button type="button" data-rc-mode="horizontal" role="menuitemradio" aria-checked="false" style="display:flex;width:100%;align-items:center;gap:8px;padding:8px 10px;border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer"><span data-rc-dot style="width:12px;text-align:center;color:#7c8cff"></span><span style="flex:1">水平切分</span></button>
  <div style="height:1px;margin:6px 8px;background:rgba(255,255,255,0.12)"></div>
  <button type="button" data-rc-swap role="menuitem" style="display:flex;width:100%;align-items:center;gap:8px;padding:8px 10px;border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer"><span style="width:12px;text-align:center;color:#7c8cff">⇄</span><span style="flex:1">交换切分</span></button>
</div>

<script>(function () {
  // A page can be re-rendered in place; the overlay must not install itself twice.
  if (window.__rcOverlay !== undefined) return
  var Z = ${Z}
  var modes = { off: 'off', vertical: 'vertical', horizontal: 'horizontal' }

  var back = document.querySelector('[data-rc="back"]')
  var split = document.querySelector('[data-rc="split"]')
  var frame = document.querySelector('[data-rc="frame"]')
  var handle = document.querySelector('[data-rc="handle"]')
  var grip = document.querySelector('[data-rc="grip"]')
  var menu = document.querySelector('[data-rc="menu"]')
  if (back === null || split === null || frame === null || handle === null || menu === null) return

  var state = { mode: modes.off, swap: false, ratio: 0.5 }

  function px () { return window.innerWidth + window.innerHeight }

  /** Size the divider and clip the iframe to the half that should be visible. */
  function paint () {
    var vertical = state.mode === modes.vertical
    var horizontal = state.mode === modes.horizontal
    var on = vertical || horizontal
    split.style.display = on ? 'block' : 'none'
    back.style.display = on ? 'none' : 'inline-flex'
    if (!on) return

    var percent = state.ratio * 100
    // Which half of the iframe survives. Swap moves it to the other side of the divider, so the reader can put the
    // remote page on either side without dragging the divider across.
    var keepStart = state.swap
    var inset
    if (vertical) {
      inset = keepStart ? 'inset(0 ' + (100 - percent) + '% 0 0)' : 'inset(0 0 0 ' + percent + '%)'
      handle.style.cssText = 'position:absolute;pointer-events:auto;touch-action:none;left:' + percent + '%;top:0;bottom:0;width:10px;margin-left:-5px;cursor:col-resize;background:rgba(140,140,150,0.35);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)'
      grip.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:34px;height:34px;display:flex;align-items:center;justify-content:center;background:rgba(18,18,20,0.92);border:1px solid rgba(255,255,255,0.22);border-radius:9999px;box-shadow:0 4px 16px rgba(0,0,0,0.45);color:#fff;cursor:col-resize'
      grip.querySelector('svg').style.transform = ''
      handle.setAttribute('aria-orientation', 'vertical')
    } else {
      inset = keepStart ? 'inset(0 0 ' + (100 - percent) + '% 0)' : 'inset(' + percent + '% 0 0 0)'
      handle.style.cssText = 'position:absolute;pointer-events:auto;touch-action:none;top:' + percent + '%;left:0;right:0;height:10px;margin-top:-5px;cursor:row-resize;background:rgba(140,140,150,0.35);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)'
      grip.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:34px;height:34px;display:flex;align-items:center;justify-content:center;background:rgba(18,18,20,0.92);border:1px solid rgba(255,255,255,0.22);border-radius:9999px;box-shadow:0 4px 16px rgba(0,0,0,0.45);color:#fff;cursor:row-resize'
      grip.querySelector('svg').style.transform = 'rotate(90deg)'
      handle.setAttribute('aria-orientation', 'horizontal')
    }
    frame.style.pointerEvents = 'auto'
    frame.style.clipPath = inset
    frame.style.webkitClipPath = inset
    handle.setAttribute('aria-valuenow', String(Math.round(percent)))
  }

  /** @param mode - one of the three modes. */
  function setMode (mode) {
    state.mode = mode
    if (mode !== modes.off && frame.getAttribute('src') !== '/remote/') frame.src = '/remote/'
    paint()
    syncMenu()
  }

  /** Mirror the current mode into the radio list. */
  function syncMenu () {
    var buttons = menu.querySelectorAll('[data-rc-mode]')
    for (var i = 0; i < buttons.length; i += 1) {
      var active = buttons[i].getAttribute('data-rc-mode') === state.mode
      buttons[i].setAttribute('aria-checked', active ? 'true' : 'false')
      buttons[i].style.background = active ? 'rgba(124,140,255,0.18)' : 'transparent'
      var dot = buttons[i].querySelector('[data-rc-dot]')
      if (dot !== null) dot.textContent = active ? '●' : '○'
    }
  }

  /** @param x - viewport x. @param y - viewport y. */
  function openMenu (x, y) {
    menu.style.display = 'block'
    menu.setAttribute('aria-hidden', 'false')
    // Measured after display so the menu's real size is known; otherwise it would open off the right edge.
    var box = menu.getBoundingClientRect()
    var left = Math.min(x, window.innerWidth - box.width - 8)
    var top = Math.min(y, window.innerHeight - box.height - 8)
    menu.style.left = Math.max(8, left) + 'px'
    menu.style.top = Math.max(8, top) + 'px'
    syncMenu()
  }

  function closeMenu () {
    menu.style.display = 'none'
    menu.setAttribute('aria-hidden', 'true')
  }

  /** @param event - a contextmenu event from any overlay handle. */
  function onOverlayContextMenu (event) {
    event.preventDefault()
    event.stopPropagation()
    openMenu(event.clientX, event.clientY)
  }

  back.addEventListener('contextmenu', onOverlayContextMenu)
  // The pill is hidden in split mode, so the divider carries the menu too; otherwise the only exit is Escape, which
  // nothing advertises.
  handle.addEventListener('contextmenu', onOverlayContextMenu)

  // A plain click still navigates; only a long press or a right click is treated as "open the menu".
  back.addEventListener('click', function () {
    closeMenu()
  })

  menu.addEventListener('click', function (event) {
    var target = event.target
    if (!(target instanceof Element)) return
    var item = target.closest('[data-rc-mode],[data-rc-swap]')
    if (item === null) return
    if (item.hasAttribute('data-rc-swap')) {
      state.swap = !state.swap
      paint()
      return
    }
    setMode(item.getAttribute('data-rc-mode'))
    closeMenu()
  })

  menu.addEventListener('mouseover', function (event) {
    var target = event.target
    if (!(target instanceof Element)) return
    var item = target.closest('[data-rc-mode],[data-rc-swap]')
    if (item !== null) item.style.background = item.getAttribute('aria-checked') === 'true'
      ? 'rgba(124,140,255,0.24)'
      : 'rgba(255,255,255,0.10)'
  })
  menu.addEventListener('mouseout', function (event) {
    var target = event.target
    if (!(target instanceof Element)) return
    var item = target.closest('[data-rc-mode],[data-rc-swap]')
    if (item !== null) item.style.background = item.getAttribute('aria-checked') === 'true'
      ? 'rgba(124,140,255,0.18)'
      : 'transparent'
  })

  document.addEventListener('pointerdown', function (event) {
    if (!(event.target instanceof Element)) return
    if (menu.contains(event.target) || event.target === back) return
    closeMenu()
  }, true)

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (menu.style.display === 'block') { closeMenu(); return }
      if (state.mode !== modes.off) { setMode(modes.off) }
    }
  })

  // --- dragging ------------------------------------------------------------
  var dragging = false

  function ratioFrom (event) {
    var vertical = state.mode === modes.vertical
    var value = vertical
      ? event.clientX / Math.max(1, window.innerWidth)
      : event.clientY / Math.max(1, window.innerHeight)
    return Math.min(0.98, Math.max(0.02, value))
  }

  handle.addEventListener('pointerdown', function (event) {
    dragging = true
    handle.setPointerCapture(event.pointerId)
    event.preventDefault()
  })
  handle.addEventListener('pointermove', function (event) {
    if (!dragging) return
    state.ratio = ratioFrom(event)
    paint()
  })
  handle.addEventListener('pointerup', function (event) {
    dragging = false
    try { handle.releasePointerCapture(event.pointerId) } catch (error) { /* already released */ }
  })
  handle.addEventListener('pointercancel', function () { dragging = false })

  // Arrow keys nudge the divider, so the comparison is usable without a pointer.
  handle.addEventListener('keydown', function (event) {
    var step = event.shiftKey ? 0.05 : 0.01
    var vertical = state.mode === modes.vertical
    if ((vertical && event.key === 'ArrowLeft') || (!vertical && event.key === 'ArrowUp')) state.ratio = Math.max(0.02, state.ratio - step)
    else if ((vertical && event.key === 'ArrowRight') || (!vertical && event.key === 'ArrowDown')) state.ratio = Math.min(0.98, state.ratio + step)
    else return
    event.preventDefault()
    paint()
  })

  window.addEventListener('resize', function () { if (state.mode !== modes.off) paint() })

  var api = { setMode: setMode, state: state, paint: paint }
  window.__rcOverlay = api
})()</script>`
}
