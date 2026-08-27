'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type StorageInfo = { disk_free_bytes: number; disk_total_bytes: number };
type RuntimeEvent = { sequence?: number; operation: string; phase: string; message: string; data: Record<string, unknown> };
type CollectionTask = {
  id: string; work_date: string; name: string; description: string;
  target_duration_s: number; actual_duration_s: number; episode_count: number;
  num_episodes: number; episode_time_s: number; reset_time_s: number; fps: number;
  session_count: number; progress_percent: number; completed: boolean; locked: boolean;
};
type TrendItem = { date: string; target_duration_s: number; actual_duration_s: number; episode_count: number };
type ActiveSession = {
  id: string; task_name: string; dataset_name: string; repo_id: string | null; work_date: string;
  saved_duration_s: number; saved_episodes: number; event: RuntimeEvent | null;
};
type ProgressPayload = {
  date: string;
  summary: {
    target_duration_s: number; actual_duration_s: number; progress_percent: number;
    episode_count: number; completed_tasks: number; total_tasks: number;
  };
  tasks: CollectionTask[];
  trend: TrendItem[];
  active_session: ActiveSession | null;
};

const EMPTY_PROGRESS: ProgressPayload = {
  date: '',
  summary: { target_duration_s: 0, actual_duration_s: 0, progress_percent: 0, episode_count: 0, completed_tasks: 0, total_tasks: 0 },
  tasks: [], trend: [], active_session: null,
};

function shanghaiDate() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init, headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(payload.detail || '操作失败');
  }
  return response.json() as Promise<T>;
}

function durationLabel(seconds: number) {
  const roundedMinutes = Math.round(seconds / 60);
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (hours && minutes) return `${hours} 小时 ${minutes} 分`;
  if (hours) return `${hours} 小时`;
  return `${minutes} 分钟`;
}

function byteLabel(bytes: number) {
  const gib = bytes / 1024 ** 3;
  return `${gib >= 100 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}

function TaskNumberInput({ value, onCommit, min, max, disabled = false }: {
  value: number; onCommit: (value: number) => void; min: number; max: number; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    const timer = window.setTimeout(() => setDraft(String(value)), 0);
    return () => window.clearTimeout(timer);
  }, [value]);

  function commit() {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const normalized = Math.min(max, Math.max(min, Math.trunc(parsed)));
    setDraft(String(normalized));
    onCommit(normalized);
  }

  return <input type="number" value={draft} min={min} max={max} disabled={disabled}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
}

export function StorageNotice({ initial, refreshKey = null }: { initial: StorageInfo | null; refreshKey?: string | number | null }) {
  const [refreshedStorage, setRefreshedStorage] = useState<StorageInfo | null>(null);

  useEffect(() => {
    const refresh = () => fetch('/api/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: { runtime: StorageInfo }) => setRefreshedStorage(payload.runtime))
      .catch(() => undefined);
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (refreshKey === null) return undefined;
    const timer = window.setTimeout(() => {
      void fetch('/api/status', { cache: 'no-store' })
        .then((response) => response.json())
        .then((payload: { runtime: StorageInfo }) => setRefreshedStorage(payload.runtime))
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshKey]);

  const storage = refreshedStorage ?? initial;
  if (!storage) return null;
  const threshold = Math.max(100 * 1024 ** 3, storage.disk_total_bytes * 0.05);
  const warning = storage.disk_free_bytes < threshold;
  return <div className={`storage-notice${warning ? ' warning' : ''}`}>
    <span>数据盘剩余</span>
    <strong>{byteLabel(storage.disk_free_bytes)}</strong>
    {warning && <small>空间偏低，请尽快清理或扩容</small>}
  </div>;
}

export function CollectionProgressPage({ runtimeEvent }: { runtimeEvent: RuntimeEvent | null }) {
  const today = shanghaiDate();
  const [view, setView] = useState<'tasks' | 'stats'>('tasks');
  const [selectedDate, setSelectedDate] = useState(today);
  const [windowDays, setWindowDays] = useState<7 | 30>(7);
  const [progress, setProgress] = useState<ProgressPayload>(EMPTY_PROGRESS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetMinutes, setTargetMinutes] = useState(60);
  const [numEpisodes, setNumEpisodes] = useState(20);
  const [episodeTime, setEpisodeTime] = useState(30);
  const [resetTime, setResetTime] = useState(10);
  const [fps, setFps] = useState(30);

  const refresh = useCallback(async () => {
    try {
      const value = await api<ProgressPayload>(`/api/collection/progress?work_date=${selectedDate}&window=${windowDays}`);
      setProgress(value); setError('');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '进度读取失败');
    } finally { setLoading(false); }
  }, [selectedDate, windowDays]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    if (runtimeEvent?.operation !== 'recording') return undefined;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh, runtimeEvent]);
  useEffect(() => {
    if (!progress.active_session) return undefined;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [progress.active_session, refresh]);

  const resetForm = () => {
    setEditingId(null); setName(''); setDescription(''); setTargetMinutes(60);
    setNumEpisodes(20); setEpisodeTime(30); setResetTime(10); setFps(30);
  };

  async function saveTask() {
    if (!name.trim() || !description.trim() || !Number.isFinite(targetMinutes) || targetMinutes <= 0) return;
    setError('');
    const body = JSON.stringify({
      ...(editingId ? {} : { work_date: selectedDate }),
      name: name.trim(), description: description.trim(), target_duration_s: targetMinutes * 60,
      num_episodes: numEpisodes, episode_time_s: episodeTime, reset_time_s: resetTime, fps,
    });
    try {
      await api(editingId ? `/api/collection/tasks/${editingId}` : '/api/collection/tasks', { method: editingId ? 'PUT' : 'POST', body });
      resetForm(); await refresh();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : '任务保存失败'); }
  }

  function beginEdit(task: CollectionTask) {
    setEditingId(task.id); setName(task.name); setDescription(task.description);
    setTargetMinutes(Math.max(1, Math.round(task.target_duration_s / 60)));
    setNumEpisodes(task.num_episodes); setEpisodeTime(task.episode_time_s);
    setResetTime(task.reset_time_s); setFps(task.fps);
  }

  async function removeTask(taskId: string) {
    try { await api(`/api/collection/tasks/${taskId}`, { method: 'DELETE' }); await refresh(); }
    catch (removeError) { setError(removeError instanceof Error ? removeError.message : '任务删除失败'); }
  }

  const chartMaximum = useMemo(() => Math.max(1, ...progress.trend.flatMap((item) => [item.target_duration_s, item.actual_duration_s])), [progress.trend]);
  const event = progress.active_session?.event;
  const stage = event?.data.stage ? String(event.data.stage) : event?.phase;
  const currentEpisode = event?.data.episode;
  const isToday = selectedDate === today;

  return <section className="progress-page">
    <div className="progress-view-switch" role="tablist" aria-label="采集进度视图">
      <button className={view === 'tasks' ? 'active' : ''} type="button" role="tab" aria-selected={view === 'tasks'} onClick={() => setView('tasks')}><strong>任务与进度</strong><small>安排当天任务，查看采集执行情况</small></button>
      <button className={view === 'stats' ? 'active' : ''} type="button" role="tab" aria-selected={view === 'stats'} onClick={() => setView('stats')}><strong>统计与趋势</strong><small>查看有效时长、完成率和每日趋势</small></button>
    </div>

    <div className="page-toolbar">
      <div className="date-controls">
        <button className="outline" type="button" onClick={() => setSelectedDate(today)}>今天</button>
        <input aria-label="选择日期" type="date" value={selectedDate} onChange={(item) => setSelectedDate(item.target.value)} />
      </div>
      {view === 'stats' && <div className="segmented-small" role="group" aria-label="趋势范围">
        {([7, 30] as const).map((days) => <button className={windowDays === days ? 'active' : ''} type="button" onClick={() => setWindowDays(days)} key={days}>{days} 天</button>)}
      </div>}
    </div>

    {error && <div className="error compact">{error}</div>}

    {view === 'stats' && <><div className="metric-grid">
      <Metric label="有效时长" value={durationLabel(progress.summary.actual_duration_s)} detail={`目标 ${durationLabel(progress.summary.target_duration_s)}`} />
      <Metric label="今日进度" value={`${progress.summary.progress_percent.toFixed(0)}%`} detail="按成功保存时长统计" />
      <Metric label="Episodes" value={String(progress.summary.episode_count)} detail="实际保存数量" />
      <Metric label="任务" value={`${progress.summary.completed_tasks} / ${progress.summary.total_tasks}`} detail="已完成 / 总数" />
    </div>

    <section className="progress-section">
      <div className="section-heading"><div><span>每日趋势</span><h2>最近 {windowDays} 天</h2></div><div className="trend-legend"><span><i />有效时长</span><span><i />目标时长</span></div></div>
      <div className={`trend-chart days-${windowDays}`}>
        {progress.trend.map((item, index) => <div className="trend-day" key={item.date} title={`${item.date} · ${durationLabel(item.actual_duration_s)} / ${durationLabel(item.target_duration_s)}`}>
          <div className="trend-bars"><i className="target" style={{ height: `${Math.max(item.target_duration_s / chartMaximum * 100, item.target_duration_s ? 3 : 0)}%` }} /><i className="actual" style={{ height: `${Math.max(item.actual_duration_s / chartMaximum * 100, item.actual_duration_s ? 3 : 0)}%` }} /></div>
          {(windowDays === 7 || index % 5 === 0 || index === progress.trend.length - 1) && <span>{item.date.slice(5)}</span>}
        </div>)}
      </div>
    </section></>}

    {view === 'tasks' && <>{progress.active_session && <section className="active-collection-card">
      <div><span>正在采集</span><strong>{progress.active_session.task_name}</strong><small>{progress.active_session.repo_id || progress.active_session.dataset_name}</small></div>
      <div><span>当前阶段</span><strong>{event?.message || '正在启动数据采集'}</strong><small>{stage || 'starting'}{currentEpisode !== undefined ? ` · Episode ${String(currentEpisode)}` : ''}</small></div>
      <div><span>本次已保存</span><strong>{durationLabel(progress.active_session.saved_duration_s)}</strong><small>{progress.active_session.saved_episodes} Episodes</small></div>
    </section>}

    <section className="progress-section">
      <div className="section-heading"><div><span>{selectedDate}</span><h2>任务进度</h2></div></div>
      <div className="task-progress-list">
        {progress.tasks.map((task) => <article className="task-progress-row" key={task.id}>
          <div className="task-progress-main"><div><strong>{task.name}</strong><p>{task.description}</p></div><span className={task.completed ? 'complete' : ''}>{task.completed ? '已完成' : '进行中'}</span></div>
          <div className="task-progress-values"><strong>{durationLabel(task.actual_duration_s)} / {durationLabel(task.target_duration_s)}</strong><span>{task.episode_count} Episodes · {task.progress_percent.toFixed(0)}%</span><small>计划 {task.num_episodes} 轮 · {task.episode_time_s} 秒 · {task.fps} FPS</small></div>
          <div className="progress-track"><i style={{ width: `${Math.min(task.progress_percent, 100)}%` }} /></div>
          {isToday && <div className="task-row-actions"><button className="text-button" type="button" onClick={() => beginEdit(task)}>编辑</button>{!task.locked && <button className="icon-button" type="button" onClick={() => void removeTask(task.id)} aria-label={`删除${task.name}`}><Trash2 size={15} /></button>}</div>}
        </article>)}
        {!loading && progress.tasks.length === 0 && <div className="empty-state">这一天还没有采集任务</div>}
        {loading && <div className="empty-state">正在读取进度</div>}
      </div>
    </section>

    {isToday && <section className="progress-section task-editor">
      <div className="section-heading"><div><span>{editingId ? '调整任务' : '今日计划'}</span><h2>{editingId ? '编辑采集任务' : '新增采集任务'}</h2></div></div>
      <div className="form-grid">
        <label>任务名称<input value={name} onChange={(item) => setName(item.target.value)} disabled={Boolean(editingId && progress.tasks.find((task) => task.id === editingId)?.locked)} placeholder="例如：积木入盒" /></label>
        <label>目标时长（分钟）<TaskNumberInput value={targetMinutes} onCommit={setTargetMinutes} min={1} max={10_080} /></label>
        <label className="full-field">任务描述<textarea value={description} onChange={(item) => setDescription(item.target.value)} disabled={Boolean(editingId && progress.tasks.find((task) => task.id === editingId)?.locked)} placeholder="写入 LeRobot 数据集的完整任务描述" /></label>
        <div className="full-field task-settings-label">采集设置</div>
        <label>采集轮数<TaskNumberInput value={numEpisodes} onCommit={setNumEpisodes} min={1} max={10_000} disabled={Boolean(editingId && progress.tasks.find((task) => task.id === editingId)?.locked)} /></label>
        <label>单轮时长（秒）<TaskNumberInput value={episodeTime} onCommit={setEpisodeTime} min={1} max={86_400} disabled={Boolean(editingId && progress.tasks.find((task) => task.id === editingId)?.locked)} /></label>
        <label>重置时间（秒）<TaskNumberInput value={resetTime} onCommit={setResetTime} min={0} max={86_400} disabled={Boolean(editingId && progress.tasks.find((task) => task.id === editingId)?.locked)} /></label>
        <label>帧率<select value={fps} onChange={(item) => setFps(Number(item.target.value))} disabled={Boolean(editingId && progress.tasks.find((task) => task.id === editingId)?.locked)}><option value="30">30 FPS</option><option value="20">20 FPS</option></select></label>
      </div>
      <div className="editor-actions">{editingId && <button className="outline" type="button" onClick={resetForm}>取消</button>}<button className="primary inline-icon" type="button" onClick={() => void saveTask()} disabled={!name.trim() || !description.trim() || !Number.isFinite(targetMinutes) || targetMinutes <= 0}><Plus size={15} />{editingId ? '保存修改' : '添加任务'}</button></div>
    </section>}</>}
  </section>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
