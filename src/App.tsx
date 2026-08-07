import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { ACESFilmicToneMapping, Box3, Color, Group, Mesh, Object3D, PCFSoftShadowMap, PerspectiveCamera, Quaternion, Sphere, Vector3 } from 'three'

const ROBOT_ASSET_URL = '/robot_optimized.glb'
const ROBOT_SOCKET_URL = 'ws://127.0.0.1:5805/robot'

// WPILib's field origin is the blue-alliance corner. The exported field is centered
// at the world origin, uses meters, and has Z as its up axis.
const FIELD_LENGTH_METERS = 16.54
const FIELD_WIDTH_METERS = 8.21
const FIELD_ORIGIN_IN_MODEL = new Vector3(-FIELD_LENGTH_METERS / 2, -FIELD_WIDTH_METERS / 2, 0)

type GraphicsInfo = {
  hardwareAccelerated: boolean
  renderer: string
}

type RobotPose = {
  position: Vector3
  quaternion: Quaternion
  timestamp?: number
}

type SocketStatus = 'connecting' | 'live' | 'reconnecting' | 'disconnected'

function parsePose(message: string): RobotPose | null {
  try {
    const data: unknown = JSON.parse(message)
    if (typeof data !== 'object' || data === null) return null

    const { position, quaternion, timestamp } = data as {
      position?: Record<string, unknown>
      quaternion?: Record<string, unknown>
      timestamp?: unknown
    }
    const values = [position?.x, position?.y, position?.z, quaternion?.x, quaternion?.y, quaternion?.z, quaternion?.w]
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null

    const rotation = new Quaternion(quaternion!.x as number, quaternion!.y as number, quaternion!.z as number, quaternion!.w as number)
    if (rotation.lengthSq() < Number.EPSILON) return null

    return {
      position: new Vector3(position!.x as number, position!.y as number, position!.z as number),
      quaternion: rotation.normalize(),
      timestamp: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined,
    }
  } catch {
    return null
  }
}

function getGraphicsInfo(context: WebGLRenderingContext | WebGL2RenderingContext): GraphicsInfo {
  const debugInfo = context.getExtension('WEBGL_debug_renderer_info')
  const renderer = debugInfo
    ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
    : String(context.getParameter(context.RENDERER))
  const softwareRenderer = /swiftshader|llvmpipe|software|mesa offscreen|microsoft basic/i.test(renderer)

  return { hardwareAccelerated: !softwareRenderer, renderer }
}

function CameraController({ scene }: { scene: Object3D }) {
  const { camera, gl, invalidate } = useThree()
  const pressedKeys = useRef(new Set<string>())
  const movementSpeed = useRef(0)
  const pitch = useRef(0)
  const forward = useRef(new Vector3())
  const right = useRef(new Vector3())
  const movement = useRef(new Vector3())
  const velocity = useRef(new Vector3())
  const worldUp = useRef(new Vector3(0, 0, 1))

  const bounds = useMemo(() => new Box3().setFromObject(scene), [scene])

  useFrame((_, delta) => {
    movement.current.set(0, 0, 0)
    camera.getWorldDirection(forward.current)
    forward.current.z = 0
    if (forward.current.lengthSq() > 0) forward.current.normalize()
    right.current.crossVectors(worldUp.current, forward.current).normalize()

    if (pressedKeys.current.has('KeyW')) movement.current.add(forward.current)
    if (pressedKeys.current.has('KeyS')) movement.current.sub(forward.current)
    if (pressedKeys.current.has('KeyD')) movement.current.sub(right.current)
    if (pressedKeys.current.has('KeyA')) movement.current.add(right.current)
    if (pressedKeys.current.has('Space')) movement.current.add(worldUp.current)
    if (pressedKeys.current.has('ShiftLeft') || pressedKeys.current.has('ShiftRight')) movement.current.sub(worldUp.current)

    if (movement.current.lengthSq() > 0) movement.current.normalize().multiplyScalar(movementSpeed.current)
    velocity.current.lerp(movement.current, 1 - Math.exp(-10 * delta))

    if (velocity.current.lengthSq() < 0.0001) {
      velocity.current.set(0, 0, 0)
      return
    }
    camera.position.addScaledVector(velocity.current, delta)
    invalidate()
  })

  useLayoutEffect(() => {
    const perspectiveCamera = camera as PerspectiveCamera
    const sphere = bounds.getBoundingSphere(new Sphere())
    const distance = sphere.radius / Math.sin((perspectiveCamera.fov * Math.PI) / 360)
    const direction = new Vector3(1, 0.7, 1).normalize()

    perspectiveCamera.position.copy(sphere.center).addScaledVector(direction, distance * 1.2)
    perspectiveCamera.up.copy(worldUp.current)
    perspectiveCamera.lookAt(sphere.center)
    Object.assign(perspectiveCamera, {
      near: Math.max(distance / 1_000, 0.01),
      far: distance * 20,
    })
    perspectiveCamera.updateProjectionMatrix()

    movementSpeed.current = Math.max(sphere.radius * 0.65, 2)
    perspectiveCamera.getWorldDirection(forward.current)
    pitch.current = Math.asin(forward.current.dot(worldUp.current))

    const updateMovementState = () => {
      invalidate()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code)) return
      event.preventDefault()
      pressedKeys.current.add(event.code)
      updateMovementState()
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!pressedKeys.current.delete(event.code)) return
      event.preventDefault()
      updateMovementState()
    }
    const clearMovement = () => {
      pressedKeys.current.clear()
    }
    const handleCanvasClick = () => {
      gl.domElement.requestPointerLock()
    }
    const handleMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== gl.domElement) return

      const nextPitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch.current - event.movementY * 0.002))
      perspectiveCamera.rotateOnWorldAxis(worldUp.current, -event.movementX * 0.002)
      perspectiveCamera.rotateX(nextPitch - pitch.current)
      pitch.current = nextPitch
      invalidate()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', clearMovement)
    gl.domElement.addEventListener('click', handleCanvasClick)
    document.addEventListener('mousemove', handleMouseMove)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', clearMovement)
      gl.domElement.removeEventListener('click', handleCanvasClick)
      document.removeEventListener('mousemove', handleMouseMove)
    }
  }, [bounds, camera, gl, invalidate])

  return null
}

function Field() {
  const gltf = useLoader(GLTFLoader, '/field_optimized.glb', (loader) => {
    loader.setMeshoptDecoder(MeshoptDecoder)
  })

  useEffect(() => {
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return
      object.castShadow = true
      object.receiveShadow = true
    })
  }, [gltf])

  return (
    <>
      <primitive object={gltf.scene} />
      <CameraController scene={gltf.scene} />
    </>
  )
}

function useRobotSocket(pose: React.MutableRefObject<RobotPose | null>, onStatus: (status: SocketStatus) => void) {
  const { invalidate } = useThree()

  useEffect(() => {
    let socket: WebSocket | null = null
    let retryTimer: number | undefined
    let attempt = 0
    let closed = false

    const connect = () => {
      onStatus(attempt === 0 ? 'connecting' : 'reconnecting')
      socket = new WebSocket(ROBOT_SOCKET_URL)

      socket.addEventListener('open', () => {
        attempt = 0
        onStatus('live')
      })
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        const nextPose = parsePose(event.data)
        if (!nextPose) return
        pose.current = nextPose
        invalidate()
      })
      socket.addEventListener('error', () => socket?.close())
      socket.addEventListener('close', () => {
        if (closed) return
        onStatus('reconnecting')
        const delay = Math.min(1_000 * 2 ** attempt, 10_000)
        attempt += 1
        retryTimer = window.setTimeout(connect, delay)
      })
    }

    connect()
    return () => {
      closed = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      socket?.close()
      onStatus('disconnected')
    }
  }, [invalidate, onStatus, pose])
}

function RobotModel({ pose }: { pose: React.MutableRefObject<RobotPose | null> }) {
  const gltf = useLoader(GLTFLoader, ROBOT_ASSET_URL, (loader) => {
    loader.setMeshoptDecoder(MeshoptDecoder)
  })
  const robot = useRef<Group>(null)
  const hasInitialPose = useRef(false)
  const { invalidate } = useThree()
  const visualPosition = useMemo(() => new Vector3(), [])
  const visualQuaternion = useMemo(() => new Quaternion(), [])

  useFrame((_, delta) => {
    const target = pose.current
    if (!robot.current || !target) return

    const targetPosition = target.position.clone().add(FIELD_ORIGIN_IN_MODEL)
    if (!hasInitialPose.current) {
      visualPosition.copy(targetPosition)
      visualQuaternion.copy(target.quaternion)
      hasInitialPose.current = true
    }
    const blend = 1 - Math.exp(-12 * delta)
    visualPosition.lerp(targetPosition, blend)
    visualQuaternion.slerp(target.quaternion, blend)
    robot.current.position.copy(visualPosition)
    robot.current.quaternion.copy(visualQuaternion)

    if (visualPosition.distanceToSquared(targetPosition) > 0.000001 || 1 - Math.abs(visualQuaternion.dot(target.quaternion)) > 0.000001) {
      invalidate()
    }
  })

  return (
    <group ref={robot}>
      <primitive object={gltf.scene} />
    </group>
  )
}

function Robot({ hasAsset, onStatus }: { hasAsset: boolean; onStatus: (status: SocketStatus) => void }) {
  const pose = useRef<RobotPose | null>(null)
  useRobotSocket(pose, onStatus)

  return hasAsset ? <RobotModel pose={pose} /> : null
}

function SceneLighting() {
  return (
    <>
      <ambientLight intensity={0.45} />
      <directionalLight
        castShadow
        intensity={2}
        position={[12, -8, 20]}
        shadow-camera-bottom={-18}
        shadow-camera-far={60}
        shadow-camera-left={-24}
        shadow-camera-near={0.1}
        shadow-camera-right={24}
        shadow-camera-top={18}
        shadow-mapSize-height={2048}
        shadow-mapSize-width={2048}
      />
      <directionalLight intensity={0.65} position={[-12, 8, 12]} />
    </>
  )
}

function FpsCounter({ onUpdate }: { onUpdate: (fps: number) => void }) {
  const sample = useRef({ frames: 0, elapsed: 0 })

  useFrame((_, delta) => {
    sample.current.frames += 1
    sample.current.elapsed += delta
    if (sample.current.elapsed < 0.5) return

    onUpdate(Math.round(sample.current.frames / sample.current.elapsed))
    sample.current.frames = 0
    sample.current.elapsed = 0
  })

  return null
}

export default function App() {
  const [graphicsInfo, setGraphicsInfo] = useState<GraphicsInfo | null>(null)
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting')
  const [hasRobotAsset, setHasRobotAsset] = useState(false)
  const [fps, setFps] = useState(0)
  const updateSocketStatus = useCallback((status: SocketStatus) => setSocketStatus(status), [])
  const updateFps = useCallback((nextFps: number) => setFps(nextFps), [])

  useEffect(() => {
    fetch(ROBOT_ASSET_URL, { method: 'HEAD' })
      .then((response) => setHasRobotAsset(response.ok))
      .catch(() => setHasRobotAsset(false))
  }, [])

  return (
    <main className="viewer">
      <Canvas
        camera={{ fov: 45 }}
        dpr={[1, 2]}
        frameloop="always"
        gl={{ antialias: true, toneMapping: ACESFilmicToneMapping, toneMappingExposure: 1.1 }}
        shadows
        onCreated={({ gl, scene }) => {
          scene.background = new Color('#111827')
          gl.shadowMap.enabled = true
          gl.shadowMap.type = PCFSoftShadowMap
          setGraphicsInfo(getGraphicsInfo(gl.getContext()))
        }}
      >
        <SceneLighting />
        <FpsCounter onUpdate={updateFps} />
        <Suspense fallback={null}>
          <Field />
          <Robot hasAsset={hasRobotAsset} onStatus={updateSocketStatus} />
        </Suspense>
      </Canvas>
      <div className="status-panel">
        <p className={`socket-status socket-status--${socketStatus}`}>
          {socketStatus === 'live' ? 'Robot telemetry live' : socketStatus === 'reconnecting' ? 'Reconnecting to robot telemetry' : socketStatus === 'connecting' ? 'Connecting to robot telemetry' : 'Robot telemetry disconnected'}
        </p>
        {!hasRobotAsset && <p className="asset-status">Preparing robot model</p>}
        <p className="fps-status">{fps} FPS</p>
        {graphicsInfo && (
          <p className={graphicsInfo.hardwareAccelerated ? 'gpu-status gpu-status--active' : 'gpu-status gpu-status--software'}>
            {graphicsInfo.hardwareAccelerated ? 'GPU acceleration active' : 'Software renderer active'}
          </p>
        )}
        <p className="hint">Click view to look · WASD to move · Space up · Shift down · Esc unlocks mouse</p>
        {graphicsInfo && <p className="renderer-name" title={graphicsInfo.renderer}>{graphicsInfo.renderer}</p>}
      </div>
    </main>
  )
}
