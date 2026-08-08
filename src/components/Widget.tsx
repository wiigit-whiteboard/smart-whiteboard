import { useEffect, useRef, useState } from 'react'
import { soundWidgetRemoved } from '../lib/sounds'
import { useWhiteboardStore } from '../store/whiteboard'
import { useUIStore } from '../store/ui'
import { useUndoStore } from '../store/undo'
import { IconButton, Input } from '@whiteboard/ui-kit'
import type { PluginPreference } from '@whiteboard/sdk'

// ── Preference fields ─────────────────────────────────────────────────────────

function PreferenceFields({ widgetId, preferences }: { widgetId: string; preferences: PluginPreference[] }) {
  const raw            = useWhiteboardStore((s) =>
    s.boards.find((b) => b.id === s.activeBoardId)?.widgets.find((w) => w.id === widgetId)?.settings
  ) ?? {}
  const updateSettings = useWhiteboardStore((s) => s.updateSettings)

  return (
    <div className="space-y-3">
      {preferences.map((pref) => (
        <Input
          key={pref.name}
          label={pref.required ? `${pref.title} *` : pref.title}
          hint={pref.description}
          type={pref.type === 'password' ? 'password' : 'text'}
          value={(raw[pref.name] as string) ?? ''}
          onChange={(e) => updateSettings(widgetId, { [pref.name]: e.target.value })}
          placeholder={pref.placeholder ?? ''}
          size="sm"
        />
      ))}
    </div>
  )
}

const DRAG_THRESHOLD = 6
const SETTINGS_W     = 260
const CLOSE_MS       = 130

// Monotonically increasing counter — each activation gets a unique z-order
let zCounter = 10


interface Props {
  id:                   string
  x:                    number
  y:                    number
  width:                number
  height:               number
  children:             React.ReactNode
  settingsContent?:     React.ReactNode
  preferences?:         PluginPreference[]
  refSize?:             { width: number; height: number }
  slotAssigned?:        boolean
  layoutTransitioning?: boolean  // enables CSS transition on position/size during layout switch
  onDoubleTap?:         (widgetId: string, x: number, y: number, hasSettings: boolean) => void
  onDropped?:           (rect: { x: number; y: number; width: number; height: number }, cursorPt: { x: number; y: number }) => void
  onDragStart?:         () => void
  onDragMove?:          (cx: number, cy: number) => void
  onDragEnd?:           () => void
}

export function Widget({ id, x, y, width, height, children, settingsContent, preferences, refSize, slotAssigned, layoutTransitioning, onDoubleTap, onDropped, onDragStart, onDragMove, onDragEnd }: Props) {
  const { updateLayout, removeWidget } = useWhiteboardStore()
  const { focusedWidgetId, setFocusedWidget, flashingWidgetId, widgetCommand, clearWidgetCommand, setFullscreenWidget, editMode } = useUIStore()
  const isFlashing = flashingWidgetId === id

  const hasPrefs    = !!(preferences && preferences.length > 0)
  const hasSettings = !!(settingsContent || hasPrefs)

  const [active,       setActive]       = useState(false)
  const [zOrder,       setZOrder]       = useState(0)
  const [dragging,     setDragging]     = useState(false)
  const [dragOrigin,   setDragOrigin]   = useState('50% 50%')
  const [showSettings, setShowSettings] = useState(false)
  const [isClosing,    setIsClosing]    = useState(false)
  const [pos,  setPos]  = useState({ x, y })
  const [size, setSize] = useState({ width, height })
  const [fullscreen,  setFullscreen] = useState(false)
  const [fsExpanded,  setFsExpanded] = useState(false)
  const [removing,    setRemoving]   = useState(false)
  const [frameAnim,   setFrameAnim]  = useState<'entrance' | 'settle' | null>('entrance')
  const fsExitTimer      = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevSlotAssigned = useRef(slotAssigned)

  const containerRef = useRef<HTMLDivElement>(null)
  const closeTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Resize (corner + edge handles) — free-floating only
  type ResizeHandle = 'se' | 'sw' | 'ne' | 'nw' | 'n' | 's' | 'e' | 'w'
  type ResizeCorner = 'se' | 'sw' | 'ne' | 'nw'
  const resizeDrag = useRef<{ pointerId: number; corner: ResizeHandle; startCX: number; startCY: number; startX: number; startY: number; startW: number; startH: number } | null>(null)

  // Pinch-to-scale — free-floating only
  const pinch = useRef<{ initialDist: number; initialW: number; initialH: number } | null>(null)

  // Refs mirror state so event handler closures stay fresh
  const posRef  = useRef({ x, y })
  const sizeRef = useRef({ width, height })

  // Triple-tap detection
  const tapCount    = useRef(0)
  const tapTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Body drag — pending until threshold crossed, then becomes a real drag
  const bodyDrag = useRef<{
    pointerId: number
    startCX:   number; startCY: number
    startX:    number; startY:  number
    dragging:  boolean
  } | null>(null)

  // Sync refs when props change (external store update)
  useEffect(() => { setPos({ x, y });         posRef.current  = { x, y }         }, [x, y])
  useEffect(() => { setSize({ width, height }); sizeRef.current = { width, height } }, [width, height])

  // Deactivate when tapping outside on touch devices
  useEffect(() => {
    if (!active || showSettings) return
    function onDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setActive(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [active, showSettings])


  // Entrance animation on mount
  useEffect(() => {
    const t = setTimeout(() => setFrameAnim(null), 500)
    return () => clearTimeout(t)
  }, [])

  // Settle animation when dropped into a slot
  useEffect(() => {
    if (!prevSlotAssigned.current && slotAssigned) {
      setFrameAnim('settle')
      const t = setTimeout(() => setFrameAnim(null), 450)
      return () => clearTimeout(t)
    }
    prevSlotAssigned.current = slotAssigned
  }, [slotAssigned])

  // Cleanup on unmount
  useEffect(() => () => {
    if (closeTimer.current)  clearTimeout(closeTimer.current)
    if (fsExitTimer.current) clearTimeout(fsExitTimer.current)
    if (tapTimer.current)    clearTimeout(tapTimer.current)
  }, [])

  // React to external focus commands (from MCP)
  useEffect(() => {
    if (focusedWidgetId === id && !fullscreen) enterFullscreen()
    else if (focusedWidgetId !== id && fullscreen) exitFullscreen()
  }, [focusedWidgetId])

  // React to widget commands sent from context menu
  useEffect(() => {
    if (!widgetCommand || widgetCommand.id !== id) return
    const { cmd } = widgetCommand
    clearWidgetCommand()
    if (cmd === 'settings') {
      openSettings()
    } else if (cmd === 'fullscreen') {
      if (fullscreen) { exitFullscreen(() => { setFocusedWidget(null); setFullscreenWidget(null) }) }
      else { enterFullscreen(); setFocusedWidget(id); setFullscreenWidget(id) }
    // split hidden — not ready for public
    // } else if (cmd === 'split') {
    //   splitWidget(id)
    } else if (cmd === 'delete') {
      const state    = useWhiteboardStore.getState()
      const snapshot = state.boards.find((b) => b.id === state.activeBoardId)?.widgets.find((w) => w.id === id)
      soundWidgetRemoved()
      setRemoving(true)
      setTimeout(() => {
        removeWidget(id)
        if (snapshot) useUndoStore.getState().push('Widget removed', snapshot)
      }, 150)
    }
  }, [widgetCommand])

  function raise() { setZOrder(++zCounter) }

  // ── Resize (4 corner + 4 edge handles) ───────────────────────────
  function onResizeDown(corner: ResizeHandle) {
    return (e: React.PointerEvent) => {
      if (focusedWidgetId && focusedWidgetId !== id) return
      e.stopPropagation()
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      resizeDrag.current = {
        pointerId: e.pointerId, corner,
        startCX: e.clientX, startCY: e.clientY,
        startX: posRef.current.x, startY: posRef.current.y,
        startW: sizeRef.current.width, startH: sizeRef.current.height,
      }
      raise()
    }
  }
  function onResizeMove(e: React.PointerEvent) {
    const rd = resizeDrag.current
    if (!rd || e.pointerId !== rd.pointerId) return
    const dx = e.clientX - rd.startCX
    const dy = e.clientY - rd.startCY
    let newW = rd.startW, newH = rd.startH, newX = rd.startX, newY = rd.startY
    if (rd.corner === 'se') { newW = Math.max(120, rd.startW + dx); newH = Math.max(80, rd.startH + dy) }
    if (rd.corner === 'sw') { newW = Math.max(120, rd.startW - dx); newX = rd.startX + (rd.startW - newW); newH = Math.max(80, rd.startH + dy) }
    if (rd.corner === 'ne') { newW = Math.max(120, rd.startW + dx); newH = Math.max(80, rd.startH - dy); newY = rd.startY + (rd.startH - newH) }
    if (rd.corner === 'nw') { newW = Math.max(120, rd.startW - dx); newX = rd.startX + (rd.startW - newW); newH = Math.max(80, rd.startH - dy); newY = rd.startY + (rd.startH - newH) }
    if (rd.corner === 'e')  { newW = Math.max(120, rd.startW + dx) }
    if (rd.corner === 'w')  { newW = Math.max(120, rd.startW - dx); newX = rd.startX + (rd.startW - newW) }
    if (rd.corner === 's')  { newH = Math.max(80, rd.startH + dy) }
    if (rd.corner === 'n')  { newH = Math.max(80, rd.startH - dy); newY = rd.startY + (rd.startH - newH) }
    sizeRef.current = { width: newW, height: newH }
    posRef.current  = { x: newX, y: newY }
    setSize({ width: newW, height: newH })
    setPos({ x: newX, y: newY })
  }
  function onResizeUp(e: React.PointerEvent) {
    if (!resizeDrag.current || e.pointerId !== resizeDrag.current.pointerId) return
    updateLayout(id, { x: posRef.current.x, y: posRef.current.y, width: sizeRef.current.width, height: sizeRef.current.height })
    resizeDrag.current = null
  }

  // ── Pinch to scale ────────────────────────────────────────────────
  function touchDist(touches: React.TouchList) {
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
  }
  function onContainerTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2 && !slotAssigned && !(focusedWidgetId && focusedWidgetId !== id)) {
      pinch.current = { initialDist: touchDist(e.touches), initialW: sizeRef.current.width, initialH: sizeRef.current.height }
    }
  }
  function onContainerTouchMove(e: React.TouchEvent) {
    if (e.touches.length !== 2 || !pinch.current) return
    const scale = touchDist(e.touches) / pinch.current.initialDist
    const newW = Math.max(120, pinch.current.initialW * scale)
    const newH = Math.max(80,  pinch.current.initialH * scale)
    sizeRef.current = { width: newW, height: newH }
    setSize({ width: newW, height: newH })
  }
  function onContainerTouchEnd() {
    if (!pinch.current) return
    updateLayout(id, { width: sizeRef.current.width, height: sizeRef.current.height })
    pinch.current = null
  }

  // ── Settings ──────────────────────────────────────────────────────
  function openSettings() {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setIsClosing(false)
    setShowSettings(true)
  }
  function closeSettings() {
    setIsClosing(true)
    closeTimer.current = setTimeout(() => { setShowSettings(false); setIsClosing(false) }, CLOSE_MS)
  }
  function toggleSettings() {
    if (showSettings && !isClosing) closeSettings()
    else openSettings()
  }

  // ── Fullscreen ────────────────────────────────────────────────────
  function enterFullscreen() {
    if (fsExitTimer.current) clearTimeout(fsExitTimer.current)
    setFullscreen(true)
    setFsExpanded(false)
    setFullscreenWidget(id)
    raise()
    // Two rAFs: first lets React commit at current pos, second triggers the expand transition
    requestAnimationFrame(() => requestAnimationFrame(() => setFsExpanded(true)))
  }
  function exitFullscreen(onComplete?: () => void) {
    setFsExpanded(false)
    setFullscreenWidget(null)
    fsExitTimer.current = setTimeout(() => {
      setFullscreen(false)
      onComplete?.()
    }, 300)
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function calcDragPos(
    startX: number, startY: number,
    startCX: number, startCY: number,
    clientX: number, clientY: number,
  ) {
    return {
      x: startX + (clientX - startCX),
      y: startY + (clientY - startCY),
    }
  }

  // ── Body drag (threshold-based: move past DRAG_THRESHOLD to drag, lift to tap) ──
  function onBodyDown(e: React.PointerEvent) {
    if (fullscreen) {
      // In fullscreen, still track pointer so onBodyUp fires for triple-tap detection
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      bodyDrag.current = { pointerId: e.pointerId, startCX: e.clientX, startCY: e.clientY, startX: 0, startY: 0, dragging: false }
      return
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    bodyDrag.current = {
      pointerId: e.pointerId,
      startCX:  e.clientX, startCY: e.clientY,
      startX:   posRef.current.x, startY: posRef.current.y,
      dragging: false,
    }
    raise()
  }

  function onBodyMove(e: React.PointerEvent) {
    const bd = bodyDrag.current
    if (!bd || e.pointerId !== bd.pointerId) return
    const dx = e.clientX - bd.startCX
    const dy = e.clientY - bd.startCY
    if (!bd.dragging) {
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
      bd.dragging = true
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        const ox = ((bd.startCX - rect.left) / rect.width  * 100).toFixed(1) + '%'
        const oy = ((bd.startCY - rect.top)  / rect.height * 100).toFixed(1) + '%'
        setDragOrigin(`${ox} ${oy}`)
      }
      onDragStart?.()
      setActive(true)
      setDragging(true)
    }
    const np = calcDragPos(bd.startX, bd.startY, bd.startCX, bd.startCY, e.clientX, e.clientY)
    posRef.current = np
    setPos(np)
    // Use cursor position (relative to canvas) for slot detection — more intuitive than widget center
    const pRect = containerRef.current?.parentElement?.getBoundingClientRect()
    const cx = pRect ? e.clientX - pRect.left : np.x + sizeRef.current.width / 2
    const cy = pRect ? e.clientY - pRect.top  : np.y + sizeRef.current.height / 2
    onDragMove?.(cx, cy)
  }

  function onBodyUp(e: React.PointerEvent) {
    const bd = bodyDrag.current
    if (!bd || e.pointerId !== bd.pointerId) return
    if (bd.dragging) {
      const finalRect = { ...calcDragPos(bd.startX, bd.startY, bd.startCX, bd.startCY, e.clientX, e.clientY), ...sizeRef.current }
      const pRect = containerRef.current?.parentElement?.getBoundingClientRect()
      const cursorPt = pRect
        ? { x: e.clientX - pRect.left, y: e.clientY - pRect.top }
        : { x: finalRect.x + finalRect.width / 2, y: finalRect.y + finalRect.height / 2 }
      updateLayout(id, finalRect)
      onDropped?.(finalRect, cursorPt)
      onDragEnd?.()
      setDragging(false)
      // Slot-assigned widgets may snap back if the drop missed a slot — reset to props.
      // Free-floating widgets keep their dragged position (props will sync via useEffect).
      if (slotAssigned) {
        setPos({ x, y })
        posRef.current = { x, y }
      }
    } else if (!editMode) {
      // Tap — single-tap selects, double-tap opens context menu, triple-tap toggles fullscreen
      tapCount.current += 1
      if (tapTimer.current) clearTimeout(tapTimer.current)
      if (tapCount.current >= 3) {
        tapCount.current = 0
        if (fullscreen) { exitFullscreen(() => { setFocusedWidget(null); setFullscreenWidget(null) }) }
        else            { enterFullscreen(); setFocusedWidget(id) }
      } else if (tapCount.current === 2) {
        tapCount.current = 0
        if (onDoubleTap) {
          const pRect = containerRef.current?.parentElement?.getBoundingClientRect()
          const cx = pRect ? e.clientX - pRect.left : pos.x + size.width  / 2
          const cy = pRect ? e.clientY - pRect.top  : pos.y + size.height / 2
          onDoubleTap(id, cx, cy, hasSettings)
        }
      } else {
        setActive(true)
        tapTimer.current = setTimeout(() => { tapCount.current = 0 }, 400)
      }
    }
    bodyDrag.current = null
  }

  // ── Commit drag on pointer cancel (touchscreen browser gesture takeover) ──
  // On touch devices the browser fires pointercancel instead of pointerup when it
  // decides to take over the touch gesture (e.g. system scroll, notification shade).
  // Previously this snapped the widget back to its drag-start position.  Instead we
  // now commit the last tracked position (posRef.current) so the widget stays where
  // the finger left it — matching the behaviour users expect from a native drag.
  function onBodyCancel(e: React.PointerEvent) {
    const bd = bodyDrag.current
    if (!bd || e.pointerId !== bd.pointerId) return
    if (bd.dragging) {
      // Use the last position tracked by onBodyMove (posRef.current) as the final rect.
      // We cannot rely on e.clientX/clientY from a cancel event — they may be 0,0.
      const finalRect = { ...posRef.current, ...sizeRef.current }
      // Use widget centre as the cursor point since we have no reliable pointer coords.
      const cursorPt = {
        x: finalRect.x + finalRect.width  / 2,
        y: finalRect.y + finalRect.height / 2,
      }
      updateLayout(id, finalRect)
      onDropped?.(finalRect, cursorPt)
      onDragEnd?.()
      setDragging(false)
      // Slot-assigned widgets snap back to their slot (same rule as onBodyUp).
      if (slotAssigned) {
        setPos({ x, y })
        posRef.current = { x, y }
      }
    }
    bodyDrag.current = null
  }

  // ── Render ────────────────────────────────────────────────────────
  const isActive    = active || showSettings || fullscreen
  const widgetStyle = useWhiteboardStore((s) => {
    const board  = s.boards.find((b) => b.id === s.activeBoardId)
    const widget = board?.widgets.find((w) => w.id === id)
    return widget?.widgetStyle ?? board?.widgetStyle ?? 'solid'
  })
  const canvasSize  = useUIStore((s) => s.canvasSize)
  const renderW = fullscreen && fsExpanded ? canvasSize.w : size.width
  const renderH = fullscreen && fsExpanded ? canvasSize.h : size.height
  const isSplit     = renderW >= 520
  const scale = refSize ? Math.min(renderW / refSize.width, renderH / refSize.height) : 1
  const DRAG_SCALE = slotAssigned ? 0.62 : 1.05

  const FS_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'
  const fsStyle: React.CSSProperties = fullscreen
    ? {
        position:    'absolute',
        left:        fsExpanded ? 0          : pos.x,
        top:         fsExpanded ? 0          : pos.y,
        width:       fsExpanded ? '100%'     : size.width,
        height:      fsExpanded ? '100%'     : size.height,
        zIndex:      9999,
        touchAction: 'none',
        transition:  `left 0.3s ${FS_EASE}, top 0.3s ${FS_EASE}, width 0.3s ${FS_EASE}, height 0.3s ${FS_EASE}`,
        borderRadius:   fsExpanded ? 0 : undefined,
        backdropFilter: (widgetStyle === 'glass' || widgetStyle === 'glass-dark' || widgetStyle === 'glass-light') ? 'blur(20px) saturate(1.6)' : undefined,
      }
    : {
        position:   'absolute',
        left:       pos.x,
        top:        pos.y,
        width:      size.width,
        height:     size.height,
        zIndex:     showSettings ? 10002 : dragging ? 500 : zOrder + (isActive ? 1 : 0),
        touchAction: 'none',
        transform:       dragging ? `scale(${DRAG_SCALE}) rotate(1.5deg)` : undefined,
        transformOrigin: dragging ? dragOrigin : 'center',
        transition:      dragging
          ? 'transform 0.22s cubic-bezier(0.34, 1.3, 0.64, 1)'
          : layoutTransitioning
          ? 'left 0.3s ease-in-out, top 0.3s ease-in-out, width 0.3s ease-in-out, height 0.3s ease-in-out, transform 0.22s cubic-bezier(0.34, 1.3, 0.64, 1)'
          : 'transform 0.22s cubic-bezier(0.34, 1.3, 0.64, 1)',
        opacity:         dragging ? 0.88 : 1,
        backdropFilter: (widgetStyle === 'glass' || widgetStyle === 'glass-dark' || widgetStyle === 'glass-light') ? 'blur(20px) saturate(1.6)' : undefined,
        animation:   removing ? 'wt-remove 0.15s cubic-bezier(0.4, 0, 1, 1) forwards' : undefined,
      }

  return (
    <div
      ref={containerRef}
      data-widget="true"
      style={fsStyle}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onBodyDown}
      onPointerMove={onBodyMove}
      onPointerUp={onBodyUp}
      onPointerCancel={onBodyCancel}
      onTouchStart={onContainerTouchStart}
      onTouchMove={onContainerTouchMove}
      onTouchEnd={onContainerTouchEnd}
    >
      {/* Edit mode delete button */}
      {editMode && !fullscreen && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            soundWidgetRemoved()
            setRemoving(true)
            setTimeout(() => removeWidget(id), 150)
          }}
          style={{
            position:   'absolute',
            top:        -10,
            left:       -10,
            zIndex:     9999,
            width:      28,
            height:     28,
            borderRadius: '50%',
            background: '#ff3b30',
            border:     '2px solid #fff',
            color:      '#fff',
            fontSize:   16,
            fontWeight: 700,
            lineHeight: 1,
            cursor:     'pointer',
            display:    'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ×
        </button>
      )}

      {/* Widget frame — content fills the entire frame, no overlapping header */}
      <div
        className={`wt-widget-frame w-full h-full overflow-hidden${(widgetStyle === 'borderless' || widgetStyle === 'none') ? ' wt-widget-frame--borderless' : ' border'}${frameAnim === 'entrance' ? ' wt-widget-entrance' : frameAnim === 'settle' ? ' wt-widget-settle' : ''}${editMode && !fullscreen ? ' widget-wiggle' : ''}`}
        style={{
          borderRadius:    fullscreen && fsExpanded ? 0 : '3rem',
          transition:      `border-radius 0.3s ${FS_EASE}, border-color 0.15s, box-shadow 0.15s, background-color 0.2s`,
          backgroundColor:
            widgetStyle === 'glass'       ? 'color-mix(in srgb, var(--wt-bg) 55%, transparent)' :
            widgetStyle === 'glass-dark'  ? 'rgba(0,0,0,0.35)' :
            widgetStyle === 'glass-light' ? 'rgba(255,255,255,0.15)' :
            (widgetStyle === 'borderless' || widgetStyle === 'none') ? 'transparent' :
            'var(--wt-bg)',
          color: widgetStyle === 'glass-dark' ? '#fff' : undefined,
          ...(widgetStyle === 'borderless' || widgetStyle === 'none'
            ? { border: 'none' }
            : widgetStyle === 'glass-dark'
            ? { borderColor: 'rgba(255,255,255,0.08)' }
            : widgetStyle === 'glass-light'
            ? { borderColor: 'rgba(255,255,255,0.3)' }
            : { borderColor: isFlashing ? 'var(--wt-danger)' : (dragging || isActive) ? 'var(--wt-border-active)' : 'var(--wt-widget-rest-border)' }
          ),
          animation:   isFlashing ? 'wt-flash 0.5s ease-in-out 4' : undefined,
          boxShadow: (widgetStyle === 'borderless' || widgetStyle === 'none')
            ? 'none'
            : widgetStyle === 'glass-dark'
            ? '0 8px 32px rgba(0,0,0,0.4)'
            : widgetStyle === 'glass-light'
            ? '0 8px 32px rgba(0,0,0,0.15)'
            : dragging
            ? `0 28px 56px rgba(0,0,0,0.38), 0 8px 16px rgba(0,0,0,0.22), inset 0 1px 0 var(--wt-widget-highlight)`
            : isActive
            ? `0 5px 0 rgba(0,0,0,0.14), var(--wt-shadow-md), inset 0 1px 0 var(--wt-widget-highlight)`
            : `0 4px 0 rgba(0,0,0,0.10), var(--wt-shadow-sm), inset 0 1px 0 var(--wt-widget-highlight)`,
        }}
      >
        <div
          className={refSize ? 'flex items-center justify-center overflow-hidden' : 'wt-content-fade'}
          style={{
            width:      (showSettings || isClosing) && isSplit ? `calc(100% - ${SETTINGS_W}px)` : '100%',
            height:     '100%',
            transition: 'width 0.25s ease',
            flexShrink: 0,
          }}
        >
          <div style={{
            width:           refSize ? refSize.width  : '100%',
            height:          refSize ? refSize.height : '100%',
            transform:       scale !== 1 ? `scale(${scale})` : undefined,
            transformOrigin: 'center',
            flexShrink:      0,
          }}>
            {children}
          </div>
        </div>

        {/* Settings panel — slides in from right inside the frame */}
        {(showSettings || isClosing) && hasSettings && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position:      'absolute',
              top:           0, right: 0, bottom: 0,
              width:         isSplit ? SETTINGS_W : '100%',
              display:       'flex',
              flexDirection: 'column',
              overflow:      'hidden',
              zIndex:        5,
              background:    'var(--wt-settings-bg)',
              borderLeft:    isSplit ? '1px solid var(--wt-settings-divider)' : undefined,
              animation:     isClosing
                ? 'wt-settings-out 0.13s ease forwards'
                : 'wt-settings-in 0.25s cubic-bezier(0.34, 1.2, 0.64, 1) forwards',
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--wt-settings-divider)' }}
            >
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--wt-settings-label)' }}>
                Settings
              </span>
              <IconButton icon="X" size="sm" variant="ghost" onClick={closeSettings} />
            </div>
            <div className="flex-1 settings-scroll overflow-y-auto px-4 py-4 space-y-4">
              {hasPrefs && <PreferenceFields widgetId={id} preferences={preferences!} />}
              {hasPrefs && settingsContent && (
                <div style={{ borderTop: '1px solid var(--wt-settings-divider)' }} className="pt-4">
                  {settingsContent}
                </div>
              )}
              {!hasPrefs && settingsContent}
            </div>
          </div>
        )}
      </div>

      {/* Resize corner + edge handles — free-floating only */}
      {!slotAssigned && isActive && !dragging && !fullscreen && !(focusedWidgetId && focusedWidgetId !== id) && (
        <>
          {([ 'nw', 'ne', 'sw', 'se' ] as const).map((corner) => {
            const isTop  = corner[0] === 'n'
            const isLeft = corner[1] === 'w'
            return (
              <div
                key={corner}
                style={{
                  position: 'absolute',
                  [isTop  ? 'top'    : 'bottom']: 0,
                  [isLeft ? 'left'   : 'right' ]: 0,
                  width: 14, height: 14,
                  zIndex: 22,
                  cursor: `${corner}-resize`,
                  borderTop:    isTop  ? '2px solid var(--wt-border-active)' : undefined,
                  borderBottom: !isTop ? '2px solid var(--wt-border-active)' : undefined,
                  borderLeft:   isLeft ? '2px solid var(--wt-border-active)' : undefined,
                  borderRight:  !isLeft ? '2px solid var(--wt-border-active)' : undefined,
                  borderTopLeftRadius:     (isTop  && isLeft)  ? 6 : undefined,
                  borderTopRightRadius:    (isTop  && !isLeft) ? 6 : undefined,
                  borderBottomLeftRadius:  (!isTop && isLeft)  ? 6 : undefined,
                  borderBottomRightRadius: (!isTop && !isLeft) ? 6 : undefined,
                  opacity: 0.6,
                }}
                onPointerDown={onResizeDown(corner)}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
              />
            )
          })}
          {/* Edge handles */}
          {([ 'n', 's', 'e', 'w' ] as const).map((edge) => {
            const isVertical = edge === 'n' || edge === 's'
            return (
              <div
                key={edge}
                style={{
                  position: 'absolute',
                  ...(isVertical
                    ? { left: 14, right: 14, height: 8, [edge === 'n' ? 'top' : 'bottom']: 0 }
                    : { top: 14, bottom: 14, width: 8, [edge === 'w' ? 'left' : 'right']: 0 }),
                  zIndex: 21,
                  cursor: `${edge}-resize`,
                }}
                onPointerDown={onResizeDown(edge)}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
              />
            )
          })}
        </>
      )}

    </div>
  )
}
