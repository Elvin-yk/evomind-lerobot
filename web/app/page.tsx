/* eslint-disable @next/next/no-img-element */
'use client';

import { Check, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { CollectionProgressPage, StorageNotice, type StorageInfo } from './collectionProgress';
import { DatasetViewerPage } from './datasetViewer';
import {
  armModeLabel, cameraDisplayLabel, cameraKindLabel, cameraSlotId, canAddCameraKind,
  categories, createSteps, defaultCameras, modelsFromProfiles, nextCameraDraft,
  type ArmMode, type CameraDraft, type CameraKind, type CreateStepId,
  type DeviceCategory, type DeviceCategoryId, type DeviceModelOption, type DeviceTransport,
  type SystemProfile,
} from './deviceCatalog';

type RuntimeEvent = {
  sequence: number; operation: string; phase: string; message: string;
  job_id: string | null; data: Record<string, unknown>; timestamp: string;
};
type RuntimeStatus = { lerobot_version: string | null; runtime: { hostname: string } & StorageInfo; event: RuntimeEvent };
type WorkflowRuntime = { running: boolean; job_id: string | null; operation: string | null; event: RuntimeEvent | null };
type Catalog = { systems: SystemProfile[] };
type SerialDevice = { id: string; path: string; device: string };
type CanDevice = { id: string; serial_number: string; interface: string; state: string; up: boolean; bitrate: number | null };
type CameraDevice = { id: string; name: string; path: string; paths: string[] };
type CameraPreview = CameraDevice & { preview_data_url: string };
type HardwareInventory = { serial: SerialDevice[]; socketcan: CanDevice[]; cameras: CameraDevice[] };
type Side = 'single' | 'left' | 'right';
type SerialKind = 'robot' | 'teleoperator';
type IdentificationScope = 'hardware' | 'sensors' | 'all';
type PageId = 'device' | 'maintenance' | 'calibration' | 'teleoperation' | 'recording' | 'collection-progress' | 'datasets' | 'inference';
type SerialBinding = {
  id: string; port: string; alias: string; kind: SerialKind; side: Side;
};
type CanBinding = { id: string; alias: string; kind: SerialKind; side: Side };
type CameraBinding = { id: string; port: string; alias: string; side: Side };
type CameraSlot = { alias: string; kind: CameraKind; side: Side };
type DeviceConfiguration = {
  profile_id: string; robot_type: string; teleoperator_type: string | null;
  camera_slots: CameraSlot[]; serial_bindings: SerialBinding[]; can_bindings: CanBinding[]; camera_bindings: CameraBinding[];
};
type HardwareSlot = { id: string; label: string; kind: SerialKind; side: Side; transport: DeviceTransport };
type MotionPort = { stable_id: string; device: string; motor_ids: number[]; delta: number; moved: boolean; motion_error: string };
type MotionStartResult = { status: string; readable_count: number; ports: MotionPort[] };
type FeetechMotor = { id: number; model: string; model_number: number; position: number; velocity: number; load: number; voltage: number; temperature: number; current: number | null; torque_enabled: boolean; moving: boolean };
type FeetechScan = { device_id: string; baudrate: number; motors: FeetechMotor[] };
type FeetechSnapshot = { positions: { id: number; position: number }[] };
type PositionSample = { capturedAt: number; positions: Record<number, number> };
type PiperMotor = {
  id: number; position: number | null; voltage: number; driver_temperature: number;
  motor_temperature: number; current: number; enabled: boolean; faults: string[];
};
type PiperSnapshot = {
  device_id: string; interface: string; firmware: string; feedback_source: 'feedback' | 'control' | 'none'; can_fps: number;
  status: { available: boolean; ctrl_mode: number; arm_status: number; mode: number; error_code: number };
  motors: PiperMotor[]; gripper: { available: boolean; position: number; effort: number };
};
type CalibrationStatus = {
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'done' | 'error';
  mode: 'auto' | 'manual' | ''; phase: string; alias: string; message: string; prompt_id: string;
  calibration_id: string; path: string; motor: string;
  profile: Record<string, unknown>; error: string; updated_at: number;
  devices: Record<string, { available: boolean; path: string; run: Omit<CalibrationStatus, 'devices'> | null }>;
};
type LocalDataset = { id: string; path: string; episodes: number; frames: number; fps: number; tasks: number };
type LocalPolicy = { id: string; path: string; type: string };
type WorkspaceInventory = { datasets: LocalDataset[]; policies: LocalPolicy[] };
type DailyCollectionTask = { id: string; name: string; description: string; target_duration_s: number; actual_duration_s: number; completed: boolean };

const menu: { id: PageId; label: string }[] = [
  { id: 'device', label: '设备' },
  { id: 'maintenance', label: '维修' },
  { id: 'calibration', label: '校准' },
  { id: 'teleoperation', label: '遥操作' },
  { id: 'recording', label: '数据采集' },
  { id: 'collection-progress', label: '采集进度' },
  { id: 'datasets', label: '数据管理' },
  { id: 'inference', label: '推理' },
];

function serialIdentity(stableId: string) {
  const match = stableId.match(/USB_Single_Serial_(.+?)-if\d+$/);
  return match?.[1] ?? stableId;
}

function serialLabel(device: Pick<SerialDevice, 'id' | 'device'>) {
  return `${device.device} · ${serialIdentity(device.id)}`;
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('读取失败');
  return response.json() as Promise<T>;
}

async function requestJson<T>(url: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json() as { detail?: string };
    throw new Error(payload.detail ?? '操作失败');
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown = {}): Promise<T> {
  return requestJson<T>(url, 'POST', body);
}

function hardwareSlots(profile: SystemProfile | undefined): HardwareSlot[] {
  if (!profile) return [];
  const slot = (id: string, label: string, kind: SerialKind, side: Side): HardwareSlot => ({
    id, label, kind, side,
    transport: (kind === 'robot' ? profile.robot_transport : profile.teleoperator_transport) ?? 'serial',
  });
  if (profile.robot_ports === 2 && profile.teleoperator_ports === 2) {
    return [
      slot('left_leader_arm', '左主臂', 'teleoperator', 'left'),
      slot('left_follower_arm', '左从臂', 'robot', 'left'),
      slot('right_leader_arm', '右主臂', 'teleoperator', 'right'),
      slot('right_follower_arm', '右从臂', 'robot', 'right'),
    ];
  }
  if (profile.robot_ports === 1 && profile.teleoperator_ports === 1) {
    return [
      slot('leader_arm', '主臂', 'teleoperator', 'single'),
      slot('follower_arm', '从臂', 'robot', 'single'),
    ];
  }
  const slots: HardwareSlot[] = [];
  for (let index = 0; index < (profile.teleoperator_ports ?? 0); index += 1) slots.push(slot(`teleoperator_${index + 1}`, `遥操作设备 ${index + 1}`, 'teleoperator', 'single'));
  for (let index = 0; index < (profile.robot_ports ?? 0); index += 1) slots.push(slot(`robot_${index + 1}`, `机器人接口 ${index + 1}`, 'robot', 'single'));
  return slots;
}

function cameraDraftsFromConfiguration(configuration: DeviceConfiguration): CameraDraft[] {
  return configuration.camera_slots.map((slot, index) => ({ id: `saved-camera-${index}-${slot.alias}`, kind: slot.kind, side: slot.side === 'left' || slot.side === 'right' ? slot.side : undefined }));
}

function isReady(configuration: DeviceConfiguration | null, profile: SystemProfile | undefined) {
  if (!configuration || !profile) return false;
  const slots = hardwareSlots(profile);
  const requiredSerial = slots.filter((slot) => slot.transport === 'serial').length;
  const requiredCan = slots.filter((slot) => slot.transport === 'socketcan').length;
  return configuration.serial_bindings.length === requiredSerial
    && configuration.can_bindings.length === requiredCan
    && configuration.camera_bindings.length === configuration.camera_slots.length;
}

export default function Home() {
  const [collapsed, setCollapsed] = useState(false);
  const [activePage, setActivePage] = useState<PageId>('device');
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog>({ systems: [] });
  const [saved, setSaved] = useState<DeviceConfiguration | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInventory>({ datasets: [], policies: [] });
  const [runtimeEvent, setRuntimeEvent] = useState<RuntimeEvent | null>(null);
  const [workflowStatusSlot, setWorkflowStatusSlot] = useState<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<CreateStepId>('category');
  const [categoryId, setCategoryId] = useState<DeviceCategoryId | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [mode, setMode] = useState<ArmMode>('single');
  const [cameras, setCameras] = useState<CameraDraft[]>([]);
  const [pendingCameraKind, setPendingCameraKind] = useState<CameraKind>('environment');
  const [serialAssignments, setSerialAssignments] = useState<Record<string, string>>({});
  const [canAssignments, setCanAssignments] = useState<Record<string, string>>({});
  const [cameraAssignments, setCameraAssignments] = useState<Record<string, string>>({});
  const [inventory, setInventory] = useState<HardwareInventory | null>(null);
  const [cameraPreviews, setCameraPreviews] = useState<CameraPreview[]>([]);
  const [motionPorts, setMotionPorts] = useState<MotionPort[]>([]);
  const [motionActive, setMotionActive] = useState(false);
  const [motionStarting, setMotionStarting] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [identificationScope, setIdentificationScope] = useState<IdentificationScope>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const models = useMemo(() => modelsFromProfiles(catalog.systems), [catalog.systems]);
  const categoryModels = models.filter((model) => model.category === categoryId);
  const selectedCategory = categories.find((category) => category.id === categoryId);
  const selectedModel = models.find((model) => model.id === modelId);
  const selectedVariant = selectedModel?.variants.find((variant) => variant.mode === mode) ?? selectedModel?.variants[0];
  const selectedProfile = selectedVariant?.profile;
  const savedModel = models.find((model) => model.variants.some((variant) => variant.profile.id === saved?.profile_id));
  const savedProfile = savedModel?.variants.find((variant) => variant.profile.id === saved?.profile_id)?.profile;
  const ready = isReady(saved, savedProfile);

  useEffect(() => {
    Promise.all([readJson<RuntimeStatus>('/api/status'), readJson<Catalog>('/api/catalog'), readJson<DeviceConfiguration | null>('/api/config'), readJson<WorkspaceInventory>('/api/workspace')])
      .then(([nextStatus, nextCatalog, configuration, nextWorkspace]) => {
        setStatus(nextStatus); setRuntimeEvent(nextStatus.event); setCatalog(nextCatalog); setSaved(configuration); setWorkspace(nextWorkspace); setEditing(!configuration);
        if (!configuration) return;
        const hydratedModel = modelsFromProfiles(nextCatalog.systems).find((model) => model.variants.some((variant) => variant.profile.id === configuration.profile_id));
        if (!hydratedModel) return;
        const variant = hydratedModel.variants.find((item) => item.profile.id === configuration.profile_id) ?? hydratedModel.variants[0];
        setCategoryId(hydratedModel.category); setModelId(hydratedModel.id); setMode(variant.mode);
        setCameras(cameraDraftsFromConfiguration(configuration));
        setSerialAssignments(Object.fromEntries(configuration.serial_bindings.map((binding) => [binding.alias, binding.id])));
        setCanAssignments(Object.fromEntries(configuration.can_bindings.map((binding) => [binding.alias, binding.id])));
      })
      .catch(() => setError('无法连接本机运行时'));
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);
    socket.onmessage = (message) => setRuntimeEvent(JSON.parse(message.data) as RuntimeEvent);
    return () => socket.close();
  }, []);

  const refreshWorkspace = useCallback(() => {
    readJson<WorkspaceInventory>('/api/workspace').then(setWorkspace).catch(() => undefined);
  }, []);

  function selectCategory(category: DeviceCategory) {
    if (!models.some((model) => model.category === category.id)) return;
    setCategoryId(category.id); setModelId(null); setError(null); setStep('model');
  }

  function selectModel(model: DeviceModelOption) {
    const nextMode = model.variants[0].mode;
    setModelId(model.id); setMode(nextMode); setCameras(defaultCameras(nextMode, model.category)); setError(null); setStep('hardware');
  }

  function updateMode(nextMode: ArmMode) {
    if (!selectedModel?.variants.some((variant) => variant.mode === nextMode)) return;
    setMode(nextMode); setCameras(defaultCameras(nextMode, categoryId ?? 'arm'));
  }

  function addCamera() {
    const camera = nextCameraDraft(cameras, mode, pendingCameraKind);
    if (camera) setCameras((current) => [...current, camera]);
  }

  function cameraSlotsFromDrafts() {
    return cameras.map((camera, index) => ({ alias: cameraSlotId(camera, cameras, index, mode), kind: camera.kind, side: (camera.kind === 'wrist' && mode === 'dual' ? camera.side ?? 'left' : 'single') as Side }));
  }

  async function saveDeclaration() {
    if (!selectedProfile) return;
    setBusy(true); setError(null);
    try {
      const configuration = await requestJson<DeviceConfiguration>('/api/config', 'PUT', { profile_id: selectedProfile.id, robot_type: selectedProfile.robot_type, teleoperator_type: selectedProfile.teleoperator_type, camera_slots: cameraSlotsFromDrafts(), serial_bindings: [], can_bindings: [], camera_bindings: [] });
      setSaved(configuration); setEditing(false); setActivePage('device'); setIdentifying(false);
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : '保存失败'); }
    finally { setBusy(false); }
  }

  const stopMotion = useCallback(async () => {
    if (!motionActive && !motionStarting) return;
    try { await postJson<{ status: string }>('/api/identify/motion/stop'); }
    finally { setMotionActive(false); setMotionStarting(false); }
  }, [motionActive, motionStarting]);

  const startMotion = useCallback(async (model: string, excludedIds: string[]) => {
    setMotionStarting(true);
    try {
      const result = await postJson<MotionStartResult>('/api/identify/motion/start', { model, excluded_ids: excludedIds });
      setMotionPorts(result.ports);
      if (result.readable_count === 0) throw new Error(result.ports.map((port) => port.motion_error).find(Boolean) || '未发现可识别的机械臂');
      setMotionActive(true);
    } finally { setMotionStarting(false); }
  }, []);

  const refreshCameras = useCallback(async () => {
    setCameraLoading(true);
    try { setCameraPreviews(await postJson<CameraPreview[]>('/api/identify/cameras')); }
    finally { setCameraLoading(false); }
  }, []);

  async function beginIdentification(scope: IdentificationScope = 'all') {
    if (!saved || !savedModel || !savedProfile) return;
    const preservedSerialAssignments = Object.fromEntries(saved.serial_bindings.map((binding) => [binding.alias, binding.id]));
    const preservedCanAssignments = Object.fromEntries(saved.can_bindings.map((binding) => [binding.alias, binding.id]));
    const preservedCameraAssignments = Object.fromEntries(cameras.flatMap((camera, index) => {
      const slot = saved.camera_slots[index];
      const binding = saved.camera_bindings.find((item) => item.alias === slot?.alias);
      return binding ? [[camera.id, binding.id]] : [];
    }));
    setBusy(true); setError(null); setIdentificationScope(scope);
    setSerialAssignments(scope === 'sensors' ? preservedSerialAssignments : {});
    setCanAssignments(scope === 'sensors' ? preservedCanAssignments : {});
    setCameraAssignments(scope === 'hardware' ? preservedCameraAssignments : {});
    setMotionPorts([]); setCameraPreviews([]); setIdentifying(true);
    try {
      const nextInventory = await readJson<HardwareInventory>('/api/devices');
      setInventory(nextInventory);
      if (scope !== 'hardware') setCameraPreviews(await postJson<CameraPreview[]>('/api/identify/cameras'));
      const firstSlot = hardwareSlots(savedProfile)[0];
      if (scope !== 'sensors' && firstSlot) await startMotion(savedModel.id, []);
    } catch (identifyError) { setError(identifyError instanceof Error ? identifyError.message : '设备识别启动失败'); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!identifying || activePage !== 'device' || !motionActive) return;
    const pendingSlots = hardwareSlots(savedProfile);
    let cancelled = false; let timer = 0;
    const poll = async () => {
      try {
        const result = await readJson<{ ports: MotionPort[] }>('/api/identify/motion/poll');
        if (cancelled) return;
        setMotionPorts(result.ports);
        const usedIds = [...Object.values(serialAssignments), ...Object.values(canAssignments)];
        const moved = result.ports.find((port) => port.moved && !usedIds.includes(port.stable_id));
        const pendingSlot = pendingSlots.find((slot) => !(slot.transport === 'socketcan' ? canAssignments[slot.id] : serialAssignments[slot.id]));
        if (moved && pendingSlot) {
          await postJson('/api/identify/motion/stop');
          if (cancelled) return;
          const nextSerialAssignments = pendingSlot.transport === 'serial' ? { ...serialAssignments, [pendingSlot.id]: moved.stable_id } : serialAssignments;
          const nextCanAssignments = pendingSlot.transport === 'socketcan' ? { ...canAssignments, [pendingSlot.id]: moved.stable_id } : canAssignments;
          setMotionActive(false); setSerialAssignments(nextSerialAssignments); setCanAssignments(nextCanAssignments);
          const nextSlot = pendingSlots.find((slot) => !(slot.transport === 'socketcan' ? nextCanAssignments[slot.id] : nextSerialAssignments[slot.id]));
          if (nextSlot && savedModel) await startMotion(savedModel.id, [...Object.values(nextSerialAssignments), ...Object.values(nextCanAssignments)]);
          return;
        }
        timer = window.setTimeout(poll, 650);
      } catch (pollError) {
        if (!cancelled) { setMotionActive(false); setError(pollError instanceof Error ? pollError.message : '机械臂识别中断'); }
      }
    };
    timer = window.setTimeout(poll, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activePage, canAssignments, identifying, motionActive, savedModel, savedProfile, serialAssignments, startMotion]);

  async function restartMotionIdentification() {
    await stopMotion(); setError(null); setSerialAssignments({}); setCanAssignments({}); setMotionPorts([]);
    if (savedModel && savedProfile && hardwareSlots(savedProfile).length > 0) {
      const firstSlot = hardwareSlots(savedProfile)[0];
      try { if (firstSlot) await startMotion(savedModel.id, []); }
      catch (motionError) { setError(motionError instanceof Error ? motionError.message : '机械臂识别启动失败'); }
    }
  }

  async function saveIdentification() {
    if (!saved || !savedProfile || !inventory) return;
    const pendingSlots = hardwareSlots(savedProfile);
    const serialPendingSlots = pendingSlots.filter((slot) => slot.transport === 'serial');
    const canPendingSlots = pendingSlots.filter((slot) => slot.transport === 'socketcan');
    if (serialPendingSlots.some((slot) => !serialAssignments[slot.id]) || canPendingSlots.some((slot) => !canAssignments[slot.id])) return setError('请完成机械臂识别');
    if (cameras.some((camera) => !cameraAssignments[camera.id])) return setError('请完成摄像头识别');
    setBusy(true);
    try {
    const serialBindings = identificationScope === 'sensors' ? saved.serial_bindings : serialPendingSlots.map((slot) => {
        const device = inventory.serial.find((item) => item.id === serialAssignments[slot.id]);
        if (!device) throw new Error(`未找到${slot.label}`);
        return { id: device.id, port: device.path, alias: slot.id, kind: slot.kind, side: slot.side };
      });
    const canBindings = identificationScope === 'sensors' ? saved.can_bindings : canPendingSlots.map((slot) => {
        const device = inventory.socketcan.find((item) => item.id === canAssignments[slot.id]);
        if (!device) throw new Error(`未找到${slot.label}`);
        return { id: device.id, alias: slot.id, kind: slot.kind, side: slot.side };
      });
    const cameraBindings = identificationScope === 'hardware' ? saved.camera_bindings : cameras.map((camera, index) => {
        const device = inventory.cameras.find((item) => item.id === cameraAssignments[camera.id]);
        if (!device) throw new Error(`未找到${cameraDisplayLabel(camera, cameras, index, mode)}`);
        const slot = saved.camera_slots[index];
        return { id: device.id, port: device.path, alias: slot.alias, side: slot.side };
      });
      const configuration = await requestJson<DeviceConfiguration>('/api/config', 'PUT', { ...saved, serial_bindings: serialBindings, can_bindings: canBindings, camera_bindings: cameraBindings });
      setSaved(configuration); await stopMotion(); setIdentifying(false); setIdentificationScope('all');
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : '保存失败'); }
    finally { setBusy(false); }
  }

  function reconfigure() {
    if (!saved || !savedModel) return;
    const variant = savedModel.variants.find((item) => item.profile.id === saved.profile_id) ?? savedModel.variants[0];
    setCategoryId(savedModel.category); setModelId(savedModel.id); setMode(variant.mode); setCameras(cameraDraftsFromConfiguration(saved));
    setEditing(true); setStep('hardware'); setActivePage('device'); setError(null);
  }

  function navigate(page: PageId) {
    const available = page === 'device' || (page === 'maintenance' ? Boolean(saved) : ready);
    if (!available) return;
    if (page !== 'device') void stopMotion();
    setActivePage(page); setError(null);
  }

  const title = activePage === 'device' ? editing ? '新增设备' : '设备' : menu.find((item) => item.id === activePage)?.label ?? '';

  return <div className={`shell ${collapsed ? 'is-collapsed' : ''}`}>
    <aside>
      <div className="brand"><span className="brand-mark">E</span>{!collapsed && <strong>Evomind</strong>}<button className="collapse" type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? '展开菜单' : '收起菜单'}>{collapsed ? '›' : '‹'}</button></div>
      <nav>{menu.map((item) => {
        const disabled = item.id === 'maintenance' ? !saved : item.id !== 'device' && !ready;
        return <button className={activePage === item.id ? 'active' : ''} type="button" disabled={disabled} onClick={() => navigate(item.id)} title={collapsed ? item.label : undefined} key={item.id}>{collapsed ? item.label.slice(0, 1) : item.label}</button>;
      })}</nav>
      <div className="runtime"><i />{!collapsed && <div><strong>{status ? '运行正常' : '正在连接'}</strong><span>LeRobot {status?.lerobot_version ?? '—'}</span></div>}</div>
    </aside>
    <main>
      <header><div><p>EVOMIND / {status?.runtime.hostname ?? '4090-c'}</p><h1>{title}</h1></div>{(['teleoperation', 'recording', 'datasets', 'inference'] as PageId[]).includes(activePage) ? <div className="header-workflow-status" ref={setWorkflowStatusSlot} /> : activePage === 'device' && saved && !editing && !identifying && <div className="header-actions"><details className="header-recognition"><summary className="outline">重新识别 <span>⌄</span></summary><div><button type="button" onClick={() => void beginIdentification('hardware')}>本体</button><button type="button" onClick={() => void beginIdentification('sensors')}>传感器</button><button type="button" onClick={() => void beginIdentification('all')}>全部设备</button></div></details><button className="outline" type="button" onClick={reconfigure}>重新配置</button></div>}</header>
      {error && <div className="error">{error}</div>}
      {activePage === 'device' && (!editing && saved ? ready && !identifying ? <DeviceOverview configuration={saved} model={savedModel} /> : !identifying ? <DeviceActivation model={savedModel} busy={busy} onStart={() => void beginIdentification()} /> : <IdentificationStep slots={hardwareSlots(savedProfile)} cameras={cameras} mode={mode} showHardware={identificationScope !== 'sensors'} showSensors={identificationScope !== 'hardware'} serialAssignments={serialAssignments} canAssignments={canAssignments} cameraAssignments={cameraAssignments} cameraPreviews={cameraPreviews} motionPorts={motionPorts} motionStarting={motionStarting} cameraLoading={cameraLoading || busy} busy={busy} onRestartMotion={() => void restartMotionIdentification()} onRefreshCameras={() => { setCameraAssignments({}); void refreshCameras().catch((cameraError) => setError(cameraError instanceof Error ? cameraError.message : '摄像头读取失败')); }} onCameraSelect={(cameraId, deviceId) => setCameraAssignments((current) => ({ ...current, [cameraId]: deviceId }))} onSave={() => void saveIdentification()} /> : <section className="device-setup">
        <div className="device-setup-steps">{createSteps.map((item, index) => {
          const disabled = item.id === 'model' ? !selectedCategory : item.id === 'hardware' ? !selectedModel : false;
          return <button className={`device-setup-step ${item.id === step ? 'active' : ''}`} type="button" disabled={disabled} onClick={() => setStep(item.id)} key={item.id}><span>{index + 1}</span>{item.label}</button>;
        })}</div>
        {step === 'category' && <div className="device-category-grid">{categories.map((category) => {
          const supported = models.some((model) => model.category === category.id);
          return <ChoiceCard title={category.title} icon={category.icon} active={category.id === categoryId} disabled={!supported} tooltip={supported ? undefined : '当前 LeRobot 未提供'} onClick={() => selectCategory(category)} key={category.id} />;
        })}</div>}
        {step === 'model' && <div className="device-model-grid">{categoryModels.map((model) => <ChoiceCard title={model.title} description={model.description} image={model.image} imageAlt={model.imageAlt} meta={model.category === 'arm' ? model.variants.map((variant) => armModeLabel(variant.mode)).join('、') : undefined} active={model.id === modelId} onClick={() => selectModel(model)} key={model.id} />)}</div>}
        {step === 'hardware' && selectedModel && selectedProfile && <HardwareStep model={selectedModel} mode={mode} cameras={cameras} pendingCameraKind={pendingCameraKind} onModeChange={updateMode} onCameraKindChange={setPendingCameraKind} onCameraSideChange={(cameraId, side) => setCameras((current) => current.map((camera) => camera.id === cameraId ? { ...camera, side } : camera))} onAddCamera={addCamera} onRemoveCamera={(id) => setCameras((current) => current.filter((camera) => camera.id !== id))} onSave={() => void saveDeclaration()} busy={busy} />}
      </section>)}
      {activePage === 'maintenance' && saved && <RepairPanel saved={saved} />}
      {activePage === 'calibration' && saved && <CalibrationPrototype configuration={saved} onConfigurationChange={setSaved} />}
      {activePage === 'teleoperation' && saved && <WorkflowPage kind="teleoperation" configuration={saved} workspace={workspace} runtimeEvent={runtimeEvent} storage={status?.runtime ?? null} statusSlot={workflowStatusSlot} onWorkspaceRefresh={refreshWorkspace} />}
      {activePage === 'recording' && saved && <WorkflowPage kind="recording" configuration={saved} workspace={workspace} runtimeEvent={runtimeEvent} storage={status?.runtime ?? null} statusSlot={workflowStatusSlot} onWorkspaceRefresh={refreshWorkspace} />}
      {activePage === 'collection-progress' && saved && <CollectionProgressPage runtimeEvent={runtimeEvent} />}
      {activePage === 'datasets' && saved && <DatasetViewerPage runtimeEvent={runtimeEvent} robotType={saved.robot_type} statusSlot={workflowStatusSlot} />}
      {activePage === 'inference' && saved && <WorkflowPage kind="inference" configuration={saved} workspace={workspace} runtimeEvent={runtimeEvent} storage={status?.runtime ?? null} statusSlot={workflowStatusSlot} onWorkspaceRefresh={refreshWorkspace} />}
    </main>
  </div>;
}

function HardwareStep({ model, mode, cameras, pendingCameraKind, onModeChange, onCameraKindChange, onCameraSideChange, onAddCamera, onRemoveCamera, onSave, busy }: { model: DeviceModelOption; mode: ArmMode; cameras: CameraDraft[]; pendingCameraKind: CameraKind; onModeChange: (mode: ArmMode) => void; onCameraKindChange: (kind: CameraKind) => void; onCameraSideChange: (cameraId: string, side: 'left' | 'right') => void; onAddCamera: () => void; onRemoveCamera: (id: string) => void; onSave: () => void; busy: boolean }) {
  return <div className="device-config-layout">
    {model.category === 'arm' && <section className="device-config-section"><div className="device-config-heading"><h3>本体形态</h3></div><div className="device-option-row">{model.variants.map((variant) => <button className={`device-option-card ${variant.mode === mode ? 'active' : ''}`} type="button" onClick={() => onModeChange(variant.mode)} key={variant.mode}><strong>{armModeLabel(variant.mode)}</strong></button>)}</div></section>}
    <section className="device-config-section"><div className="device-config-heading"><h3>摄像头</h3></div><div className="device-camera-list">{cameras.map((camera, index) => <div className="device-camera-row declared" key={camera.id}><span>{index + 1}</span><strong>{cameraKindLabel(camera.kind)}</strong>{camera.kind === 'wrist' && mode === 'dual' && <div className="device-segmented device-side-segmented" role="group" aria-label="腕部标注">{(['left', 'right'] as const).map((side) => <button className={(camera.side ?? 'left') === side ? 'active' : ''} type="button" disabled={cameras.some((item) => item.id !== camera.id && item.kind === 'wrist' && item.side === side)} onClick={() => onCameraSideChange(camera.id, side)} key={side}>{side === 'left' ? '左腕' : '右腕'}</button>)}</div>}<button className="device-camera-remove" type="button" onClick={() => onRemoveCamera(camera.id)} aria-label="删除摄像头"><Trash2 size={16} /></button></div>)}</div><div className="device-camera-add-panel"><span>添加类型</span><div className="device-segmented">{(['wrist', 'environment'] as CameraKind[]).map((kind) => <button className={pendingCameraKind === kind ? 'active' : ''} type="button" onClick={() => onCameraKindChange(kind)} disabled={!canAddCameraKind(cameras, mode, kind)} key={kind}>{cameraKindLabel(kind)}</button>)}</div><button className="device-add-camera" type="button" onClick={onAddCamera} disabled={!canAddCameraKind(cameras, mode, pendingCameraKind)}><Plus size={15} />添加</button></div></section>
    <div className="device-setup-actions"><button className="primary" type="button" onClick={onSave} disabled={busy}>{busy ? '保存中' : '保存设备'}</button></div>
  </div>;
}

function IdentificationStep({ slots, cameras, mode, showHardware, showSensors, serialAssignments, canAssignments, cameraAssignments, cameraPreviews, motionPorts, motionStarting, cameraLoading, busy, onRestartMotion, onRefreshCameras, onCameraSelect, onSave }: { mode: ArmMode; slots: HardwareSlot[]; cameras: CameraDraft[]; showHardware: boolean; showSensors: boolean; serialAssignments: Record<string, string>; canAssignments: Record<string, string>; cameraAssignments: Record<string, string>; cameraPreviews: CameraPreview[]; motionPorts: MotionPort[]; motionStarting: boolean; cameraLoading: boolean; busy: boolean; onRestartMotion: () => void; onRefreshCameras: () => void; onCameraSelect: (cameraId: string, deviceId: string) => void; onSave: () => void }) {
  const assignment = (slot: HardwareSlot) => slot.transport === 'socketcan' ? canAssignments[slot.id] : serialAssignments[slot.id];
  const currentSlot = slots.find((slot) => !assignment(slot));
  const currentCamera = cameras.find((camera) => !cameraAssignments[camera.id]);
  const completed = !currentSlot && !currentCamera;
  const readablePorts = motionPorts.filter((port) => !port.motion_error).length;
  return <div className="identification-layout">
    {showHardware && slots.length > 0 && <section className="identify-section"><div className="device-config-heading with-action"><h3>本体</h3><button className="text-button" type="button" onClick={onRestartMotion}>重新识别</button></div><div className="identify-slots">{slots.map((slot) => {
      const deviceId = assignment(slot); const identified = Boolean(deviceId); const active = currentSlot?.id === slot.id;
      return <div className={`identify-slot ${active ? 'active' : ''}`} key={slot.id}><span className={`identify-dot ${identified ? 'complete' : ''}`}>{identified ? <Check size={14} /> : ''}</span><strong>{slot.label}</strong><small>{identified ? `已识别 · ${slot.transport === 'socketcan' ? deviceId : serialIdentity(deviceId)}` : active ? motionStarting ? '正在连接' : readablePorts ? '请轻轻移动这只机械臂' : '没有可读取的机械臂' : '等待识别'}</small></div>;
    })}</div></section>}
    {showSensors && cameras.length > 0 && <section className="identify-section"><div className="device-config-heading with-action"><h3>传感器</h3><button className="text-button inline-icon" type="button" onClick={onRefreshCameras} disabled={cameraLoading}><RefreshCw size={13} />{cameraLoading ? '读取中' : '重新识别'}</button></div>{currentCamera && <p className="identify-prompt">请选择 <strong>{cameraDisplayLabel(currentCamera, cameras, cameras.indexOf(currentCamera), mode)}</strong> 的画面</p>}<div className="identify-camera-grid">{cameraPreviews.map((camera) => {
      const assignedEntry = Object.entries(cameraAssignments).find(([, id]) => id === camera.id); const assignedCamera = cameras.find((item) => item.id === assignedEntry?.[0]); const assignedIndex = assignedCamera ? cameras.indexOf(assignedCamera) : -1;
      return <button className={`identify-camera-card ${assignedCamera ? 'used' : ''}`} type="button" disabled={!currentCamera || Boolean(assignedCamera)} onClick={() => currentCamera && onCameraSelect(currentCamera.id, camera.id)} key={camera.id}><img src={camera.preview_data_url} alt={camera.name} /><span>{assignedCamera ? <><Check size={14} />{cameraDisplayLabel(assignedCamera, cameras, assignedIndex, mode)}</> : '选择此画面'}</span></button>;
    })}</div>{!cameraLoading && cameraPreviews.length === 0 && <p className="empty">未读取到摄像头画面</p>}</section>}
    <div className="device-setup-actions"><button className="primary" type="button" onClick={onSave} disabled={busy || !completed}>{busy ? '保存中' : '完成识别'}</button></div>
  </div>;
}

function RepairPanel({ saved }: { saved: DeviceConfiguration }) {
  const configuredTypes = [saved.robot_type, saved.teleoperator_type];
  const supportsFeetech = configuredTypes.some((type) => type && ['so100_follower', 'so100_leader', 'so101_follower', 'so101_leader', 'bi_so_follower', 'bi_so_leader'].includes(type));
  const supportsPiper = configuredTypes.some((type) => type && ['piperx_follower', 'piperx_leader', 'bi_piperx_follower', 'bi_piperx_leader'].includes(type));
  return <div className="repair-layout">{supportsFeetech ? <FeetechPanel saved={saved} /> : supportsPiper ? <PiperPanel saved={saved} /> : <p className="empty">当前设备暂未提供维修工具。</p>}</div>;
}

const piperControlModes: Record<number, string> = { 0: '待机', 1: 'CAN 控制', 2: '示教', 3: '以太网控制', 4: 'Wi-Fi 控制', 5: '遥控器控制', 6: '联动示教', 7: '离线轨迹' };
const piperArmStatuses: Record<number, string> = { 0: '正常', 1: '急停', 2: '无解', 3: '奇异点', 4: '目标超限', 5: '关节通信异常', 6: '抱闸未打开', 7: '碰撞保护', 8: '拖动超速', 9: '关节状态异常', 10: '其他异常', 14: '主控过温', 15: '释放电阻过温' };
const piperJointLimits: Record<number, [number, number]> = { 1: [-150, 150], 2: [0, 180], 3: [-170, 0], 4: [-100, 100], 5: [-70, 70], 6: [-120, 120] };

function piperCanLabel(device: CanDevice) {
  return `${device.interface} · ${device.serial_number || device.id}`;
}

function PiperPanel({ saved }: { saved: DeviceConfiguration }) {
  const [devices, setDevices] = useState<CanDevice[]>([]);
  const [deviceId, setDeviceId] = useState(saved.can_bindings[0]?.id ?? '');
  const [snapshot, setSnapshot] = useState<PiperSnapshot | null>(null);
  const [history, setHistory] = useState<PositionSample[]>([]);
  const [targets, setTargets] = useState<Record<number, number>>({});
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);
  const [controlArmed, setControlArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const selectedDevice = devices.find((device) => device.id === deviceId);
  const scannedDeviceId = snapshot?.device_id;

  const loadDevices = useCallback(async () => {
    try {
      const inventory = await readJson<HardwareInventory>('/api/devices');
      setDevices(inventory.socketcan);
      setDeviceId((current) => inventory.socketcan.some((device) => device.id === current) ? current : inventory.socketcan[0]?.id ?? '');
    } catch { setError('读取 CAN 控制器失败'); }
  }, []);

  useEffect(() => {
    readJson<HardwareInventory>('/api/devices')
      .then((inventory) => {
        setDevices(inventory.socketcan);
        setDeviceId((current) => inventory.socketcan.some((device) => device.id === current) ? current : inventory.socketcan[0]?.id ?? '');
      })
      .catch(() => setError('读取 CAN 控制器失败'));
  }, []);

  useEffect(() => () => {
    void fetch('/api/maintenance/piper/close', { method: 'POST', keepalive: true });
  }, []);

  async function scanArm() {
    if (!deviceId) return;
    setBusy(true); setError(null); setLiveError(null); setControlArmed(false);
    try {
      const result = await postJson<PiperSnapshot>('/api/maintenance/piper/scan', { device_id: deviceId });
      setSnapshot(result);
      const positions = Object.fromEntries(result.motors.flatMap((motor) => motor.position === null ? [] : [[motor.id, motor.position]]));
      setTargets(positions); setHistory([{ capturedAt: Date.now(), positions }]);
    } catch (scanError) { setError(scanError instanceof Error ? scanError.message : 'PiperX 读取失败'); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!scannedDeviceId) return;
    let cancelled = false; let timer = 0;
    const poll = async () => {
      try {
        const result = await postJson<PiperSnapshot>('/api/maintenance/piper/snapshot', { device_id: scannedDeviceId });
        if (cancelled) return;
        setSnapshot(result); setLiveError(null);
        const positions = Object.fromEntries(result.motors.flatMap((motor) => motor.position === null ? [] : [[motor.id, motor.position]]));
        setTargets((current) => Object.fromEntries(result.motors.map((motor) => [motor.id, motor.id === draggingId ? current[motor.id] ?? motor.position ?? 0 : motor.position ?? current[motor.id] ?? 0])));
        setHistory((current) => [...current, { capturedAt: Date.now(), positions }].slice(-60));
        timer = window.setTimeout(poll, 300);
      } catch (pollError) {
        if (cancelled) return;
        setLiveError(pollError instanceof Error ? pollError.message : '实时读取中断');
        timer = window.setTimeout(poll, 1000);
      }
    };
    timer = window.setTimeout(poll, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [draggingId, scannedDeviceId]);

  function armControl() {
    if (controlArmed) return setControlArmed(false);
    if (window.confirm('启用控制后可以使能 PiperX 关节。请扶稳机械臂并确认周围安全。')) setControlArmed(true);
  }

  async function action(motorId: number, actionName: 'enable' | 'disable' | 'move', value?: number) {
    if (!snapshot || (actionName !== 'disable' && !controlArmed)) return;
    setActingId(motorId); setError(null);
    try {
      const result = await postJson<PiperSnapshot>('/api/maintenance/piper/action', { device_id: snapshot.device_id, motor_id: motorId, action: actionName, value, confirmed: actionName !== 'disable' });
      setSnapshot(result);
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'PiperX 操作失败'); }
    finally { setActingId(null); }
  }

  const available = snapshot?.feedback_source !== 'none';
  const armStatus = snapshot?.status.available ? (piperArmStatuses[snapshot.status.arm_status] ?? `状态 ${snapshot.status.arm_status}`) : '未收到状态帧';
  return <section className="piper-panel">
    <div className="piper-toolbar">
      <div className="controller-field"><div className="field-label"><label htmlFor="piper-controller">CAN 控制器</label><button className="text-button inline-icon" type="button" onClick={() => void loadDevices()}><RefreshCw size={15} />刷新</button></div><select id="piper-controller" value={deviceId} onChange={(event) => { setDeviceId(event.target.value); setSnapshot(null); setHistory([]); setControlArmed(false); }}>{devices.map((device) => <option value={device.id} key={device.id}>{piperCanLabel(device)}</option>)}</select></div>
      <button className="primary inline-icon" type="button" onClick={() => void scanArm()} disabled={busy || !deviceId}><RefreshCw size={16} />{busy ? '读取中' : '读取机械臂'}</button>
    </div>
    {error && <div className="error compact">{error}</div>}
    {snapshot && <div className="piper-workspace">
      <div className="bus-heading"><div><p>{selectedDevice ? piperCanLabel(selectedDevice) : snapshot.device_id}</p><h3>PiperX</h3></div><div className="bus-actions"><span className={`live-state ${liveError ? 'failed' : ''}`}>{liveError ? '读取中断' : '实时读取中'}</span><button className={`outline ${controlArmed ? 'armed' : ''}`} type="button" onClick={armControl}>{controlArmed ? '锁定控制' : '启用控制'}</button></div></div>
      <div className="piper-summary">
        <div><span>固件</span><strong>{snapshot.firmware || '未读取'}</strong></div>
        <div><span>反馈</span><strong>{snapshot.feedback_source === 'feedback' ? '状态反馈' : snapshot.feedback_source === 'control' ? '主臂控制反馈' : '无反馈'}</strong></div>
        <div><span>控制模式</span><strong>{snapshot.status.available ? (piperControlModes[snapshot.status.ctrl_mode] ?? `模式 ${snapshot.status.ctrl_mode}`) : '—'}</strong></div>
        <div><span>机械臂状态</span><strong className={snapshot.status.arm_status ? 'failed-status' : ''}>{armStatus}</strong></div>
        <div><span>CAN 帧率</span><strong>{snapshot.can_fps.toFixed(0)} FPS</strong></div>
        <div><span>夹爪</span><strong>{snapshot.gripper.available ? `${snapshot.gripper.position.toFixed(1)} mm` : '未读取'}</strong></div>
      </div>
      {!available && <p className="empty">这个接口已连接，但暂未收到关节反馈。主臂静止时可能只在移动后产生控制反馈。</p>}
      <PiperPositionChart motors={snapshot.motors} history={history} />
      <div className="piper-bulk-actions"><button className="outline" type="button" onClick={() => void action(7, 'disable')} disabled={actingId !== null}>全部失能</button><button className="primary" type="button" onClick={() => void action(7, 'enable')} disabled={!controlArmed || actingId !== null}>全部使能</button></div>
      <div className="piper-motor-list">{snapshot.motors.map((motor) => {
        const [minimum, maximum] = piperJointLimits[motor.id]; const target = targets[motor.id] ?? motor.position ?? 0;
        return <div className="piper-motor-row" key={motor.id}>
        <div><strong>关节 {motor.id}</strong><span>{motor.position === null ? '—' : `${motor.position.toFixed(2)}°`}</span></div>
        <div className="position-control piper-position-control"><span>{minimum}</span><input type="range" min={minimum} max={maximum} step="0.1" value={target} disabled={!controlArmed || !motor.enabled || snapshot.feedback_source !== 'feedback' || actingId !== null} onPointerDown={() => setDraggingId(motor.id)} onChange={(event) => setTargets((current) => ({ ...current, [motor.id]: Number(event.target.value) }))} onPointerUp={(event) => { setDraggingId(null); void action(motor.id, 'move', Number(event.currentTarget.value)); }} onKeyUp={(event) => { if (event.key === 'Enter') void action(motor.id, 'move', Number(event.currentTarget.value)); }} /><span>{maximum}</span><output>{target.toFixed(1)}°</output></div>
        <div className="piper-telemetry"><span>{motor.voltage.toFixed(1)} V</span><span>{motor.current.toFixed(2)} A</span><span>驱动 {motor.driver_temperature} °C</span><span>电机 {motor.motor_temperature} °C</span></div>
        <div className={`piper-faults ${motor.faults.length ? 'failed' : ''}`}>{motor.faults.length ? motor.faults.join(' · ') : '状态正常'}</div>
        <button className={`torque-button ${motor.enabled ? 'enabled' : ''}`} type="button" disabled={actingId !== null || (!controlArmed && !motor.enabled)} onClick={() => void action(motor.id, motor.enabled ? 'disable' : 'enable')}>{actingId === motor.id ? '处理中' : motor.enabled ? '已使能' : '使能'}</button>
      </div>;})}</div>
    </div>}
  </section>;
}

function FeetechPanel({ saved }: { saved: DeviceConfiguration }) {
  const baudrates = [1_000_000, 500_000, 250_000, 128_000, 115_200, 57_600, 38_400, 19_200];
  const [devices, setDevices] = useState<SerialDevice[]>([]);
  const [deviceId, setDeviceId] = useState(saved.serial_bindings[0]?.id ?? '');
  const [baudrate, setBaudrate] = useState(1_000_000);
  const [scan, setScan] = useState<FeetechScan | null>(null);
  const [busMotors, setBusMotors] = useState<{ id: number; model: string }[]>([]);
  const [history, setHistory] = useState<PositionSample[]>([]);
  const [targets, setTargets] = useState<Record<number, number>>({});
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [controlArmed, setControlArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const selectedDevice = devices.find((device) => device.id === deviceId);
  const scannedDeviceId = scan?.device_id;
  const scannedBaudrate = scan?.baudrate;

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true); setError(null);
    try {
      const inventory = await readJson<HardwareInventory>('/api/devices');
      setDevices(inventory.serial);
      setDeviceId((current) => inventory.serial.some((device) => device.id === current) ? current : inventory.serial[0]?.id ?? '');
      setScan(null); setBusMotors([]); setHistory([]); setControlArmed(false);
    } catch { setError('读取控制器失败'); }
    finally { setDevicesLoading(false); }
  }, []);

  useEffect(() => {
    readJson<HardwareInventory>('/api/devices')
      .then((inventory) => {
        setDevices(inventory.serial);
        setDeviceId((current) => inventory.serial.some((device) => device.id === current) ? current : inventory.serial[0]?.id ?? '');
      })
      .catch(() => setError('读取控制器失败'));
  }, []);

  async function refresh() {
    if (!deviceId) return;
    setBusy(true); setError(null);
    try {
      const result = await postJson<FeetechScan>('/api/maintenance/feetech/scan', { device_id: deviceId, baudrate });
      setScan(result);
      setBusMotors(result.motors.map((motor) => ({ id: motor.id, model: motor.model })));
      const initialPositions = Object.fromEntries(result.motors.map((motor) => [motor.id, motor.position]));
      setTargets(initialPositions);
      setHistory(result.motors.length ? [{ capturedAt: Date.now(), positions: initialPositions }] : []);
      setControlArmed(false); setLiveError(null);
    } catch (scanError) { setError(scanError instanceof Error ? scanError.message : '扫描失败'); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!scannedDeviceId || !scannedBaudrate || !busMotors.length) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const snapshot = await postJson<FeetechSnapshot>('/api/maintenance/feetech/snapshot', {
          device_id: scannedDeviceId,
          baudrate: scannedBaudrate,
          motors: busMotors,
        });
        if (cancelled) return;
        const positions = Object.fromEntries(snapshot.positions.map((item) => [item.id, item.position]));
        setScan((current) => current ? { ...current, motors: current.motors.map((motor) => ({ ...motor, position: positions[motor.id] ?? motor.position })) } : current);
        setTargets((current) => Object.fromEntries(Object.entries(current).map(([id, target]) => [id, Number(id) === draggingId ? target : positions[Number(id)] ?? target])));
        setHistory((current) => [...current, { capturedAt: Date.now(), positions }].slice(-60));
        setLiveError(null);
        timer = window.setTimeout(poll, 200);
      } catch (pollError) {
        if (cancelled) return;
        setLiveError(pollError instanceof Error ? pollError.message : '实时读取中断');
        timer = window.setTimeout(poll, 800);
      }
    };
    timer = window.setTimeout(poll, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [busMotors, draggingId, scannedBaudrate, scannedDeviceId]);

  function armControl() {
    if (controlArmed) return setControlArmed(false);
    if (window.confirm('启用后可开启扭矩并移动机械臂。请确认机械臂周围安全。')) setControlArmed(true);
  }

  async function action(motorId: number, name: 'torque_enable' | 'torque_disable' | 'move', value?: number) {
    if (!deviceId) return;
    if (name !== 'torque_disable' && !controlArmed) return setError('请先启用控制');
    setActingId(motorId); setError(null);
    try {
      const result = await postJson<FeetechScan>('/api/maintenance/feetech/action', { device_id: deviceId, baudrate, motor_id: motorId, action: name, value, confirmed: name === 'move' });
      setScan(result);
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : '操作失败'); }
    finally { setActingId(null); }
  }

  return <section className="feetech-panel">
    <div className="feetech-toolbar">
      <div className="controller-field"><div className="field-label"><label htmlFor="feetech-controller">控制器</label><button className="text-button inline-icon" type="button" onClick={() => void loadDevices()} disabled={devicesLoading}><RefreshCw size={15} />{devicesLoading ? '刷新中' : '刷新'}</button></div><select id="feetech-controller" value={deviceId} onChange={(event) => { setDeviceId(event.target.value); setScan(null); setBusMotors([]); setHistory([]); }}>{devices.map((device) => <option value={device.id} title={device.id} key={device.id}>{serialLabel(device)}</option>)}</select></div>
      <label>波特率<select value={baudrate} onChange={(event) => { setBaudrate(Number(event.target.value)); setScan(null); setBusMotors([]); setHistory([]); }}>{baudrates.map((value) => <option value={value} key={value}>{value.toLocaleString()}</option>)}</select></label>
      <button className="primary inline-icon" type="button" onClick={() => void refresh()} disabled={busy || !deviceId}><RefreshCw size={16} />{busy ? '扫描中' : '扫描总线'}</button>
    </div>
    {error && <div className="error compact">{error}</div>}
    {scan && scan.motors.length === 0 && <p className="empty">这个控制器下没有发现飞特舵机。</p>}
    {scan && scan.motors.length > 0 && <div className="bus-workspace">
      <div className="bus-heading"><div><p>{selectedDevice ? serialLabel(selectedDevice) : scan.device_id}</p><h3>{scan.motors.length} 个舵机</h3></div><div className="bus-actions"><span className={`live-state ${liveError ? 'failed' : ''}`}>{liveError ? '读取中断' : '实时读取中'}</span><button className={`outline ${controlArmed ? 'armed' : ''}`} type="button" onClick={armControl}>{controlArmed ? '锁定控制' : '启用控制'}</button></div></div>
      <PositionChart motors={scan.motors} history={history} />
      <div className="servo-control-list">{scan.motors.map((motor) => {
        const target = targets[motor.id] ?? motor.position;
        const working = actingId === motor.id;
        return <div className="servo-control-row" key={motor.id}>
          <div className="servo-row-title"><div><strong>ID {motor.id}</strong><span>{motor.model}</span></div><div className="servo-readouts"><span>{motor.position}</span><small>{motor.temperature} °C · {motor.voltage.toFixed(1)} V</small></div></div>
          <div className="position-control"><span>0</span><input type="range" min="0" max="4095" step="1" value={target} disabled={!controlArmed || !motor.torque_enabled || working} onPointerDown={() => setDraggingId(motor.id)} onChange={(event) => setTargets((current) => ({ ...current, [motor.id]: Number(event.target.value) }))} onPointerUp={(event) => { setDraggingId(null); void action(motor.id, 'move', Number(event.currentTarget.value)); }} onKeyUp={(event) => { if (event.key === 'Enter') void action(motor.id, 'move', Number(event.currentTarget.value)); }} /><span>4095</span><output>{target}</output></div>
          <button className={`torque-button ${motor.torque_enabled ? 'enabled' : ''}`} type="button" disabled={working || (!controlArmed && !motor.torque_enabled)} onClick={() => void action(motor.id, motor.torque_enabled ? 'torque_disable' : 'torque_enable')}>{working ? '处理中' : motor.torque_enabled ? '扭矩已开启' : '开启扭矩'}</button>
        </div>;
      })}</div>
    </div>}
  </section>;
}

const chartColors = ['#2e7652', '#db7a4d', '#4f78c4', '#9a63b5', '#d2a52d', '#3e9ca7', '#c65368', '#6f7c72'];

function PiperPositionChart({ motors, history }: { motors: PiperMotor[]; history: PositionSample[] }) {
  const width = 920; const height = 260; const left = 48; const top = 18; const plotWidth = width - left - 16; const plotHeight = height - top - 32;
  const minimum = -180; const maximum = 180; const yTicks = [-180, -90, 0, 90, 180];
  const yFor = (value: number) => top + plotHeight - ((value - minimum) / (maximum - minimum)) * plotHeight;
  return <section className="position-chart"><div className="chart-title"><div><h3>实时关节角度</h3><span>度</span></div><div className="chart-legend">{motors.map((motor, index) => <span key={motor.id}><i style={{ background: chartColors[index % chartColors.length] }} />关节 {motor.id}</span>)}</div></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="PiperX 关节实时角度折线图" preserveAspectRatio="none">
    {yTicks.map((tick) => <g key={tick}><line x1={left} x2={width - 16} y1={yFor(tick)} y2={yFor(tick)} className="chart-grid-line" /><text x={left - 9} y={yFor(tick) + 4} textAnchor="end">{tick}</text></g>)}
    {motors.map((motor, motorIndex) => {
      const points = history.flatMap((sample, index) => {
        const value = sample.positions[motor.id];
        if (value === undefined) return [];
        const x = left + (history.length <= 1 ? plotWidth : (index / (history.length - 1)) * plotWidth);
        return [`${x},${yFor(value)}`];
      }).join(' ');
      return <polyline key={motor.id} points={points} fill="none" stroke={chartColors[motorIndex % chartColors.length]} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />;
    })}
  </svg></section>;
}

function PositionChart({ motors, history }: { motors: FeetechMotor[]; history: PositionSample[] }) {
  const width = 920; const height = 260; const left = 48; const top = 18; const plotWidth = width - left - 16; const plotHeight = height - top - 32;
  const yTicks = [0, 1024, 2048, 3072, 4095];
  return <section className="position-chart"><div className="chart-title"><div><h3>实时位置</h3><span>0–4095</span></div><div className="chart-legend">{motors.map((motor, index) => <span key={motor.id}><i style={{ background: chartColors[index % chartColors.length] }} />ID {motor.id}</span>)}</div></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="舵机实时位置折线图" preserveAspectRatio="none">
    {yTicks.map((tick) => {
      const y = top + plotHeight - (tick / 4095) * plotHeight;
      return <g key={tick}><line x1={left} x2={width - 16} y1={y} y2={y} className="chart-grid-line" /><text x={left - 9} y={y + 4} textAnchor="end">{tick}</text></g>;
    })}
    {motors.map((motor, motorIndex) => {
      const points = history.map((sample, index) => {
        const x = left + (history.length <= 1 ? plotWidth : (index / (history.length - 1)) * plotWidth);
        const y = top + plotHeight - ((sample.positions[motor.id] ?? motor.position) / 4095) * plotHeight;
        return `${x},${y}`;
      }).join(' ');
      return <polyline key={motor.id} points={points} fill="none" stroke={chartColors[motorIndex % chartColors.length]} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />;
    })}
  </svg></section>;
}
function ChoiceCard({ active, title, description, image, imageAlt, meta, tooltip, icon: Icon, disabled = false, onClick }: { active: boolean; title: string; description?: string; image?: string; imageAlt?: string; meta?: string; tooltip?: string; icon?: LucideIcon; disabled?: boolean; onClick: () => void }) { return <button className={`device-template-card ${active ? 'active' : ''} ${disabled ? 'unsupported' : ''}`} type="button" onClick={onClick} disabled={disabled} title={tooltip}>{Icon && <Icon size={22} />}{image && <div className="device-model-visual"><img src={image} alt={imageAlt ?? ''} /></div>}<strong>{title}</strong>{description && <span>{description}</span>}{meta && <small>{meta}</small>}</button>; }

function DeviceActivation({ model, busy, onStart }: { model?: DeviceModelOption; busy: boolean; onStart: () => void }) {
  return <section className="activation-view"><div><span className="eyebrow">设备已保存</span><h2>{model?.title ?? '当前设备'}</h2><p>完成机械臂和摄像头识别后即可使用全部功能。</p></div><button className="primary" type="button" onClick={onStart} disabled={busy}>{busy ? '正在启动' : '开始识别'}</button></section>;
}

function bindingTitle(alias: string) {
  const labels: Record<string, string> = {
    left_leader_arm: '左主臂', left_follower_arm: '左从臂', right_leader_arm: '右主臂', right_follower_arm: '右从臂',
    leader_arm: '主臂', follower_arm: '从臂', left_wrist: '左腕摄像头', right_wrist: '右腕摄像头', environment_1: '环境摄像头',
  };
  return labels[alias] ?? alias.replaceAll('_', ' ');
}

function DeviceOverview({ configuration, model }: { configuration: DeviceConfiguration; model?: DeviceModelOption }) {
  const [inventory, setInventory] = useState<HardwareInventory | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => readJson<HardwareInventory>('/api/devices')
      .then((nextInventory) => { if (!cancelled) setInventory(nextInventory); })
      .catch(() => { if (!cancelled) setInventory(null); });
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const serialIds = new Set(inventory?.serial.map((device) => device.id) ?? []);
  const canDevices = new Map(inventory?.socketcan.map((device) => [device.id, device]) ?? []);
  const cameraIds = new Set(inventory?.cameras.map((device) => device.id) ?? []);
  const bindings = [
    ...configuration.serial_bindings.map((binding) => ({ id: binding.id, alias: binding.alias, kind: binding.kind === 'robot' ? '机械臂' : '遥操作设备', port: binding.port, online: serialIds.has(binding.id) })),
    ...configuration.can_bindings.map((binding) => ({ id: binding.id, alias: binding.alias, kind: binding.kind === 'robot' ? '机械臂 · CAN' : '遥操作设备 · CAN', port: canDevices.get(binding.id)?.interface ?? binding.id, online: canDevices.has(binding.id) })),
    ...configuration.camera_bindings.map((binding) => ({ id: binding.id, alias: binding.alias, kind: '摄像头', port: binding.port, online: cameraIds.has(binding.id) })),
  ];
  const offlineCount = inventory ? bindings.filter((binding) => !binding.online).length : 0;
  return <section className="device-overview">
    <div className="overview-hero"><div className={offlineCount ? 'offline-status' : ''}><span className="status-dot" />{inventory ? offlineCount ? `${offlineCount} 个接口未连接` : '全部接口在线' : '正在检查接口'}</div><h2>{model?.title ?? configuration.profile_id}</h2><p>{configuration.robot_type}{configuration.teleoperator_type ? ` + ${configuration.teleoperator_type}` : ''}</p></div>
    <div className="data-list"><div className="data-list-head"><span>设备</span><span>类型</span><span>接口</span><span>状态</span></div>{bindings.map((binding) => <div className="data-row" key={`${binding.alias}-${binding.id}`}><strong>{bindingTitle(binding.alias)}</strong><span>{binding.kind}</span><code title={binding.port}>{binding.port}</code><span className={`row-status${inventory && !binding.online ? ' offline' : ''}`}><i />{inventory ? binding.online ? '在线' : '未连接' : '检查中'}</span></div>)}</div>
  </section>;
}

function CalibrationPrototype({ configuration, onConfigurationChange }: { configuration: DeviceConfiguration; onConfigurationChange: (configuration: DeviceConfiguration) => void }) {
  if (configuration.can_bindings.length > 0 && configuration.serial_bindings.length === 0) {
    return <section className="workspace-view"><div className="activation-view"><div><span className="eyebrow">绝对编码器</span><h2>不需要校准</h2><p>PiperX 使用绝对编码器，设备连接后可直接使用。</p></div></div></section>;
  }
  return <SerialCalibrationPrototype configuration={configuration} onConfigurationChange={onConfigurationChange} />;
}

function SerialCalibrationPrototype({ configuration, onConfigurationChange }: { configuration: DeviceConfiguration; onConfigurationChange: (configuration: DeviceConfiguration) => void }) {
  const [status, setStatus] = useState<CalibrationStatus | null>(null);
  const [error, setError] = useState('');
  const refreshedRun = useRef(0);
  const active = status?.state === 'starting' || status?.state === 'running' || status?.state === 'stopping';

  const refresh = useCallback(async () => {
    const next = await readJson<CalibrationStatus>('/api/calibration/status');
    setStatus(next);
    if (next.state === 'done' && next.updated_at !== refreshedRun.current) {
      refreshedRun.current = next.updated_at;
      onConfigurationChange(await readJson<DeviceConfiguration>('/api/config'));
    }
  }, [onConfigurationChange]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try { await refresh(); }
      catch (pollError) { if (!cancelled) setError(pollError instanceof Error ? pollError.message : '无法读取校准状态'); }
    };
    void poll();
    return () => { cancelled = true; };
  }, [refresh]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void refresh().catch((pollError) => setError(pollError instanceof Error ? pollError.message : '无法读取校准状态'));
    }, 700);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  async function startManual(alias: string) {
    setError('');
    if (!window.confirm('手动校准需要移动机械臂所有关节。请确认周围空间安全。')) return;
    try { setStatus(await postJson<CalibrationStatus>('/api/calibration/manual/start', { alias })); }
    catch (startError) { setError(startError instanceof Error ? startError.message : '校准启动失败'); }
  }

  async function startAuto(alias?: string) {
    setError('');
    const message = alias
      ? `${bindingTitle(alias)}将自动移动。请清空周围空间并确认供电稳定。`
      : '所有尚未启动的机械臂将同时自动移动。请清空机械臂周围空间并确认供电稳定。';
    if (!window.confirm(message)) return;
    try { setStatus(await postJson<CalibrationStatus>('/api/calibration/auto/start', alias ? { alias } : {})); }
    catch (startError) { setError(startError instanceof Error ? startError.message : '自动校准启动失败'); }
  }

  async function advanceManual() {
    setError('');
    try { setStatus(await postJson<CalibrationStatus>('/api/calibration/manual/advance')); }
    catch (advanceError) { setError(advanceError instanceof Error ? advanceError.message : '无法进入下一步'); }
  }

  async function stop() {
    setError('');
    try { setStatus(await postJson<CalibrationStatus>('/api/calibration/stop')); }
    catch (stopError) { setError(stopError instanceof Error ? stopError.message : '自动校准停止失败'); }
  }

  function supportsAuto(binding: SerialBinding) {
    const type = binding.kind === 'robot' ? configuration.robot_type : configuration.teleoperator_type ?? '';
    return ['so101_follower', 'so101_leader', 'bi_so_follower', 'bi_so_leader'].includes(type);
  }

  function supportsManual(binding: SerialBinding) {
    const type = binding.kind === 'robot' ? configuration.robot_type : configuration.teleoperator_type ?? '';
    return ['so100_follower', 'so100_leader', 'so101_follower', 'so101_leader', 'bi_so_follower', 'bi_so_leader'].includes(type);
  }

  const manualAction = status?.mode === 'manual' && status.prompt_id === 'calibration_middle'
    ? '已放到中位'
    : status?.mode === 'manual' && status.phase === 'recording_ranges' ? '完成范围记录' : '';

  const automaticCount = configuration.serial_bindings.filter(supportsAuto).length;
  const remainingAutomaticCount = active
    ? configuration.serial_bindings.filter((binding) => supportsAuto(binding) && !status?.devices[binding.alias]?.run).length
    : automaticCount;
  const autoBatchJoinable = !active || status?.mode === 'auto';

  return <section className="workspace-view">
    {error && <div className="error compact">{error}</div>}
    {automaticCount > 1 && <div className="calibration-batch-actions"><button className="primary" type="button" disabled={!autoBatchJoinable || remainingAutomaticCount === 0 || status?.state === 'stopping'} onClick={() => void startAuto()}>并行自动校准</button></div>}
    {status && status.state !== 'idle' && <div className={`calibration-progress ${status.state}`}><div><span>{status.mode === 'auto' ? '自动校准' : status.alias ? bindingTitle(status.alias) : '校准'}</span><strong>{status.message || '等待开始'}</strong>{status.motor && <small>当前关节：{status.motor}</small>}</div>{active && <div className="calibration-progress-actions">{manualAction && <button className="primary" type="button" onClick={() => void advanceManual()}>{manualAction}</button>}<button className="outline" type="button" onClick={() => void stop()} disabled={status.state === 'stopping'}>{status.state === 'stopping' ? '正在停止' : '停止'}</button></div>}</div>}
    <div className="action-list">{configuration.serial_bindings.map((binding) => {
      const run = status?.devices[binding.alias]?.run;
      const running = run?.state === 'starting' || run?.state === 'running' || run?.state === 'stopping' || (active && status?.mode === 'manual' && status.alias === binding.alias);
      const automatic = supportsAuto(binding);
      const manual = supportsManual(binding);
      const calibrated = status?.devices[binding.alias]?.available ?? false;
      const runFailed = run?.state === 'error';
      const autoDisabled = !automatic || !autoBatchJoinable || (active && Boolean(run)) || status?.state === 'stopping';
      return <div className="action-row" key={binding.id}><div><strong>{bindingTitle(binding.alias)}</strong><span>{binding.kind === 'robot' ? '机械臂' : '遥操作设备'}</span></div><code>{serialIdentity(binding.id)}</code><span className={runFailed ? 'failed-status' : calibrated ? 'calibrated-status' : 'muted-status'} title={run?.error || ''}>{running ? run?.motor ? `校准中 · ${run.motor}` : '校准中' : runFailed ? '校准失败' : calibrated ? '有校准文件' : '未校准'}</span><div className="calibration-actions"><button className="outline" type="button" disabled={active || !manual} onClick={() => void startManual(binding.alias)}>手动校准</button>{automatic && <button className="outline" type="button" disabled={autoDisabled} onClick={() => void startAuto(binding.alias)}>自动校准</button>}</div></div>;
    })}</div>
  </section>;
}

function RememberedNumberInput({ value, onCommit, storageKey, min, max, disabled }: {
  value: number;
  onCommit: (value: number) => void;
  storageKey: string;
  min: number;
  max?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));

  const normalize = useCallback((candidate: string) => {
    const parsed = Number(candidate);
    if (!candidate.trim() || !Number.isFinite(parsed)) return null;
    return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, Math.trunc(parsed)));
  }, [max, min]);

  useEffect(() => {
    let timer: number | undefined;
    try {
      const remembered = window.localStorage.getItem(storageKey);
      if (remembered === null) return;
      const next = normalize(remembered);
      if (next === null) return;
      timer = window.setTimeout(() => {
        setDraft(String(next));
        onCommit(next);
      }, 0);
    } catch { /* Local storage can be unavailable in hardened browsers. */ }
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [normalize, onCommit, storageKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDraft(String(value)), 0);
    return () => window.clearTimeout(timer);
  }, [value]);

  function commit() {
    const next = normalize(draft);
    if (next === null) {
      setDraft(String(value));
      return;
    }
    setDraft(String(next));
    onCommit(next);
    try { window.localStorage.setItem(storageKey, String(next)); } catch { /* Keep the input usable without persistence. */ }
  }

  return <input
    type="number"
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    disabled={disabled}
    min={min}
    max={max}
  />;
}

function WorkflowPage({ kind, configuration, workspace, runtimeEvent, storage, statusSlot, onWorkspaceRefresh }: { kind: 'teleoperation' | 'recording' | 'inference' | 'replay'; configuration: DeviceConfiguration; workspace: WorkspaceInventory; runtimeEvent: RuntimeEvent | null; storage: StorageInfo | null; statusSlot: HTMLDivElement | null; onWorkspaceRefresh: () => void }) {
  const followers = [...configuration.serial_bindings, ...configuration.can_bindings].filter((binding) => binding.kind === 'robot');
  const content = {
    teleoperation: { title: '遥操作', operation: 'teleoperation', endpoint: '/api/runtime/teleoperation/start', button: '开始遥操作', note: '' },
    recording: { title: '数据采集', operation: 'recording', endpoint: '/api/runtime/recording/start', button: '开始采集', note: '' },
    inference: { title: '推理', operation: 'rollout', endpoint: '/api/runtime/rollout/start', button: '开始推理', note: 'Policy 将直接控制机械臂' },
    replay: { title: '回放', operation: 'replay', endpoint: '/api/runtime/replay/start', button: '开始回放', note: '回放会直接驱动机械臂执行记录动作' },
  }[kind];
  const [fps, setFps] = useState(30);
  const [datasetName, setDatasetName] = useState('policy-rollout');
  const [task, setTask] = useState('');
  const [taskId, setTaskId] = useState('');
  const [dailyTasks, setDailyTasks] = useState<DailyCollectionTask[]>([]);
  const [episodes, setEpisodes] = useState(kind === 'recording' ? 20 : 10);
  const [episodeTime, setEpisodeTime] = useState(30);
  const [resetTime, setResetTime] = useState(10);
  const [duration, setDuration] = useState(120);
  const [strategy, setStrategy] = useState<'episodic' | 'sentry'>('episodic');
  const [policyPath, setPolicyPath] = useState(workspace.policies[0]?.path ?? '');
  const [datasetId, setDatasetId] = useState(workspace.datasets[0]?.id ?? '');
  const [episode, setEpisode] = useState(0);
  const [runtime, setRuntime] = useState<WorkflowRuntime>({ running: false, job_id: null, operation: null, event: null });
  const [operationError, setOperationError] = useState('');
  const [pendingCommand, setPendingCommand] = useState<'stop' | 'finish_episode' | 'rerecord_episode' | null>(null);
  const pendingSequence = useRef(0);
  const wasRunning = useRef(false);

  useEffect(() => {
    const refresh = () => readJson<WorkflowRuntime>('/api/runtime/status').then(setRuntime).catch(() => undefined);
    void refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (kind !== 'recording') return;
    readJson<DailyCollectionTask[]>('/api/collection/tasks')
      .then((tasks) => { setDailyTasks(tasks); setTaskId((current) => current || tasks[0]?.id || ''); })
      .catch(() => setDailyTasks([]));
  }, [kind]);

  useEffect(() => {
    let timer: number | undefined;
    try {
      const remembered = Number(window.localStorage.getItem(`evomind-lerobot:${kind}:fps`));
      if ([15, 20, 30].includes(remembered)) timer = window.setTimeout(() => setFps(remembered), 0);
    } catch { /* Use the default FPS when local storage is unavailable. */ }
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [kind]);

  useEffect(() => {
    if (wasRunning.current && !runtime.running) onWorkspaceRefresh();
    wasRunning.current = runtime.running;
  }, [onWorkspaceRefresh, runtime.running]);

  const effectivePolicyPath = policyPath || workspace.policies[0]?.path || '';
  const effectiveDatasetId = datasetId || workspace.datasets[0]?.id || '';
  const selectedDataset = workspace.datasets.find((item) => item.id === effectiveDatasetId);
  const selectedPolicy = workspace.policies.find((item) => item.path === effectivePolicyPath);
  const selectedTask = dailyTasks.find((item) => item.id === taskId);
  const runningThis = runtime.running && runtime.operation === content.operation;
  const runningOther = runtime.running && !runningThis;
  const event = runtimeEvent?.operation === content.operation
    ? runtimeEvent
    : runtime.event?.operation === content.operation ? runtime.event : null;
  const visibleError = operationError || (event?.phase === 'failed' ? event.message : '');

  useEffect(() => {
    if (pendingCommand && event && event.sequence > pendingSequence.current) setPendingCommand(null);
  }, [event, pendingCommand]);

  function updateFps(value: number) {
    setFps(value);
    try { window.localStorage.setItem(`evomind-lerobot:${kind}:fps`, String(value)); } catch { /* Keep the selector usable without persistence. */ }
  }

  async function start() {
    setOperationError('');
    let body: Record<string, unknown> = { fps };
    if (kind === 'recording') body = { task_id: taskId, fps, num_episodes: episodes, episode_time_s: episodeTime, reset_time_s: resetTime };
    if (kind === 'inference') body = { policy_path: effectivePolicyPath, strategy, task, dataset_name: datasetName, fps, duration_s: duration, num_episodes: episodes, episode_time_s: episodeTime, reset_time_s: resetTime };
    if (kind === 'replay') body = { dataset_id: effectiveDatasetId, episode };
    try { setRuntime(await postJson<WorkflowRuntime>(content.endpoint, body)); }
    catch (startError) { setOperationError(startError instanceof Error ? startError.message : '启动失败'); }
  }

  async function command(value: 'stop' | 'finish_episode' | 'rerecord_episode') {
    pendingSequence.current = event?.sequence ?? 0;
    setPendingCommand(value);
    try { setRuntime(await postJson<WorkflowRuntime>('/api/runtime/command', { command: value })); }
    catch (commandError) {
      setPendingCommand(null);
      setOperationError(commandError instanceof Error ? commandError.message : '操作失败');
    }
  }

  const canStart = kind === 'teleoperation'
    || (kind === 'recording' && Boolean(taskId))
    || (kind === 'inference' && Boolean(effectivePolicyPath && datasetName.trim() && task.trim()))
    || (kind === 'replay' && Boolean(selectedDataset));

  const compactWorkflow = kind === 'teleoperation' || kind === 'recording';
  const recordingPhase = event?.phase;
  const canControlEpisode = runningThis && recordingPhase === 'running' && !pendingCommand;
  const canSkipReset = runningThis && recordingPhase === 'resetting' && !pendingCommand;

  return <section className={`workflow-page${compactWorkflow ? ' compact-workflow' : ''}${kind === 'teleoperation' ? ' teleoperation-workflow' : ''}${kind === 'recording' ? ' recording-workflow' : ''}`}>
    {statusSlot && createPortal(<WorkflowSummary kind={kind} dataset={selectedDataset} policy={selectedPolicy} event={event} error={visibleError} />, statusSlot)}
    <div className="workflow-grid"><div className="workflow-primary">
      {kind === 'teleoperation' && <WorkflowSection title="控制设置"><div className="form-grid"><label className="full-field">控制频率<select value={fps} onChange={(item) => updateFps(Number(item.target.value))} disabled={runningThis}><option value="30">30 FPS</option><option value="20">20 FPS</option><option value="15">15 FPS</option></select></label></div></WorkflowSection>}
      {kind === 'recording' && <><StorageNotice initial={storage} refreshKey={runtimeEvent?.operation === 'recording' && runtimeEvent.data.stage === 'episode_saved' ? runtimeEvent.sequence : null} /><WorkflowSection title="数据集"><div className="form-grid"><label className="full-field">今日任务<select value={taskId} onChange={(item) => setTaskId(item.target.value)} disabled={runningThis}>{dailyTasks.length === 0 && <option value="">请先在采集进度中创建今日任务</option>}{dailyTasks.map((item) => <option value={item.id} key={item.id}>{item.name}{item.completed ? ' · 已完成' : ''}</option>)}</select></label>{selectedTask && <div className="selected-task-description"><span>任务描述</span><strong>{selectedTask.description}</strong><small>目标 {Math.round(selectedTask.target_duration_s / 60)} 分钟 · 已完成 {Math.round(selectedTask.actual_duration_s / 60)} 分钟</small></div>}</div></WorkflowSection><WorkflowSection title="采集设置"><div className="form-grid"><label>采集轮数<RememberedNumberInput value={episodes} onCommit={setEpisodes} storageKey="evomind-lerobot:recording:num-episodes" min={1} max={10_000} disabled={runningThis} /></label><label>单轮时长<RememberedNumberInput value={episodeTime} onCommit={setEpisodeTime} storageKey="evomind-lerobot:recording:episode-time" min={1} max={86_400} disabled={runningThis} /></label><label>重置时间<RememberedNumberInput value={resetTime} onCommit={setResetTime} storageKey="evomind-lerobot:recording:reset-time" min={0} max={86_400} disabled={runningThis} /></label><label>帧率<select value={fps} onChange={(item) => updateFps(Number(item.target.value))} disabled={runningThis}><option value="30">30 FPS</option><option value="20">20 FPS</option></select></label></div></WorkflowSection></>}
      {kind === 'inference' && <><WorkflowSection title="策略"><div className="form-grid"><label className="full-field">Policy<input list="local-policies" value={effectivePolicyPath} onChange={(item) => setPolicyPath(item.target.value)} disabled={runningThis} placeholder="本地路径或 Hugging Face repo id" /><datalist id="local-policies">{workspace.policies.map((policy) => <option value={policy.path} key={policy.path}>{policy.id}</option>)}</datalist></label><label>Rollout 策略<select value={strategy} onChange={(item) => setStrategy(item.target.value as 'episodic' | 'sentry')} disabled={runningThis}><option value="episodic">Episodic</option><option value="sentry">Sentry</option></select></label><label>最大运行时间<input type="number" value={duration} onChange={(item) => setDuration(Number(item.target.value))} disabled={runningThis} min="1" /></label><label className="full-field">任务描述<input value={task} onChange={(item) => setTask(item.target.value)} disabled={runningThis} placeholder="描述 Policy 要执行的任务" /></label><label className="full-field">结果数据集<input value={datasetName} onChange={(item) => setDatasetName(item.target.value)} disabled={runningThis} /></label></div></WorkflowSection>{strategy === 'episodic' && <WorkflowSection title="Episode"><div className="form-grid"><label>采集轮数<input type="number" value={episodes} onChange={(item) => setEpisodes(Number(item.target.value))} disabled={runningThis} min="1" /></label><label>单轮时长<input type="number" value={episodeTime} onChange={(item) => setEpisodeTime(Number(item.target.value))} disabled={runningThis} min="1" /></label><label>重置时间<input type="number" value={resetTime} onChange={(item) => setResetTime(Number(item.target.value))} disabled={runningThis} min="0" /></label><label>帧率<select value={fps} onChange={(item) => setFps(Number(item.target.value))} disabled={runningThis}><option value="30">30 FPS</option><option value="20">20 FPS</option></select></label></div></WorkflowSection>}</>}
      {kind === 'replay' && <><WorkflowSection title="回放来源"><div className="form-grid"><label className="full-field">数据集<select value={effectiveDatasetId} onChange={(item) => { setDatasetId(item.target.value); setEpisode(0); }} disabled={runningThis}>{workspace.datasets.length === 0 && <option value="">没有本地数据集</option>}{workspace.datasets.map((dataset) => <option value={dataset.id} key={dataset.id}>{dataset.id}</option>)}</select></label><label>Episode<input type="number" value={episode} onChange={(item) => setEpisode(Number(item.target.value))} disabled={runningThis} min="0" max={Math.max(0, (selectedDataset?.episodes ?? 1) - 1)} /></label></div></WorkflowSection><WorkflowSection title="执行设备">{followers.map((follower) => <div className="workflow-device" key={follower.id}><div><strong>{bindingTitle(follower.alias)}</strong><span>{serialIdentity(follower.id)}</span></div><i>已连接</i></div>)}</WorkflowSection></>}
      <div className="workflow-actions">{content.note && <span>{content.note}</span>}<div className={`workflow-command-buttons${runningThis && kind === 'recording' ? ` episode-controls${recordingPhase === 'resetting' ? ' resetting-controls' : ''}` : ''}`}>{runningThis && kind === 'recording' && <><button className="primary" type="button" disabled={!canControlEpisode} onClick={() => void command('finish_episode')}>{pendingCommand === 'finish_episode' && recordingPhase !== 'resetting' ? '正在保存' : '保存这一段'}</button><button className="outline" type="button" disabled={!canControlEpisode} onClick={() => void command('rerecord_episode')}>{pendingCommand === 'rerecord_episode' ? '正在重录' : '重录这一段'}</button>{recordingPhase === 'resetting' && <button className="outline" type="button" disabled={!canSkipReset} onClick={() => void command('finish_episode')}>{pendingCommand === 'finish_episode' ? '正在跳过' : '跳过等待'}</button>}</>}<button className={runningThis ? 'danger' : 'primary'} type="button" disabled={runningOther || Boolean(pendingCommand) || (!runningThis && !canStart)} onClick={() => runningThis ? void command('stop') : void start()}>{runningThis ? pendingCommand === 'stop' ? '正在结束' : kind === 'recording' ? '结束采集' : '停止' : content.button}</button></div></div>
    </div></div>
  </section>;
}

function WorkflowSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="workflow-section"><h3>{title}</h3>{children}</section>;
}

function WorkflowSummary({ kind, dataset, policy, event, error }: { kind: 'teleoperation' | 'recording' | 'inference' | 'replay'; dataset?: LocalDataset; policy?: LocalPolicy; event: RuntimeEvent | null; error: string }) {
  const state = error || event?.message || '等待开始';
  const phaseDetail = error && event?.phase !== 'failed' ? '启动失败' : event ? `${event.phase} · ${new Date(event.timestamp).toLocaleTimeString()}` : '尚未启动';
  if (kind === 'teleoperation') return <div className="workflow-summary"><SummaryItem label="运行状态" value={state} detail={event?.data.fps ? `${Number(event.data.fps).toFixed(1)} FPS` : phaseDetail} /></div>;
  if (kind === 'recording') return <div className="workflow-summary"><SummaryItem label="采集状态" value={state} detail={event?.data.saved_episodes !== undefined ? `已保存 ${String(event.data.saved_episodes)} Episodes` : phaseDetail} /></div>;
  if (kind === 'inference') return <div className="workflow-summary"><SummaryItem label="运行状态" value={state} detail={phaseDetail} /><SummaryItem label="模型" value={policy?.id ?? '未选择'} detail={policy ? `${policy.type} · 本地 checkpoint` : '未发现本地模型'} /></div>;
  return <div className="workflow-summary"><SummaryItem label="回放状态" value={state} detail={event?.data.frame !== undefined ? `${String(event.data.frame)} / ${String(event.data.total_frames ?? '—')} 帧` : phaseDetail} /><SummaryItem label={dataset ? dataset.id : '数据集'} value={dataset ? `${dataset.frames} 帧` : '未选择'} detail={dataset ? `${dataset.episodes} Episodes · ${dataset.fps || '—'} FPS` : '未发现本地数据集'} /></div>;
}

function SummaryItem({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div><span>{label}</span><strong>{value}</strong><p>{detail}</p></div>;
}
