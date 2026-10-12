import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { DisplayScene } from './types'

export function CadViewport({ scene, selectedId, hidden, onSelect }: { scene: DisplayScene; selectedId: string | null; hidden: Set<string>; onSelect(id: string): void }) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({ selectedId, hidden, onSelect }); latest.current = { selectedId, hidden, onSelect }
  const [error, setError] = useState('')
  useEffect(() => {
    const element = host.current!
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }) }
    catch { setError('3D 显示不可用，请使用实体表和工程预览。'); return }
    setError('')
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.setClearColor(0xf1f4f7)
    element.appendChild(renderer.domElement)
    renderer.domElement.setAttribute('aria-label', 'STEP 三维模型')
    const world = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100000)
    camera.up.set(0, 0, 1)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    world.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2.5))
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(1, -2, 3); world.add(light)
    const objects = scene.meshes.map((m, n) => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3))
      geometry.setIndex(m.indices); geometry.computeVertexNormals()
      const material = new THREE.MeshStandardMaterial({ color: n % 2 ? 0x8b9da8 : 0xb8a275, roughness: 0.65, metalness: 0.15, side: THREE.DoubleSide })
      const object = new THREE.Mesh(geometry, material); object.userData.id = m.id; world.add(object)
      return object
    })
    const box = new THREE.Box3().setFromObject(world)
    const center = box.getCenter(new THREE.Vector3()); const diagonal = Math.max(box.getSize(new THREE.Vector3()).length(), 0.1)
    controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(1, -1.4, 1).normalize().multiplyScalar(diagonal * 1.8))
    camera.near = diagonal / 10000; camera.far = diagonal * 100; camera.updateProjectionMatrix()
    const resize = () => { const width = Math.max(element.clientWidth, 1); const height = Math.max(element.clientHeight, 1); renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix() }
    const observer = new ResizeObserver(resize); observer.observe(element); resize()
    let start = { x: 0, y: 0 }
    const down = (e: PointerEvent) => { start = { x: e.clientX, y: e.clientY } }
    const pick = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return
      const bounds = renderer.domElement.getBoundingClientRect()
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((e.clientX - bounds.left) / bounds.width * 2 - 1, -(e.clientY - bounds.top) / bounds.height * 2 + 1), camera)
      const hit = ray.intersectObjects(objects.filter(o => o.visible))[0]
      if (hit) latest.current.onSelect(hit.object.userData.id)
    }
    renderer.domElement.addEventListener('pointerdown', down); renderer.domElement.addEventListener('pointerup', pick)
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      for (const o of objects) {
        o.visible = !latest.current.hidden.has(o.userData.id)
        o.material.emissive.setHex(o.userData.id === latest.current.selectedId ? 0x005f9b : 0)
      }
      controls.update(); renderer.render(world, camera)
    }; draw()
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', down); renderer.domElement.removeEventListener('pointerup', pick)
      for (const o of objects) { o.geometry.dispose(); o.material.dispose() }
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove()
    }
  }, [scene])
  return <div className="cad-viewport" ref={host}>{error && <p role="alert">{error}</p>}</div>
}
