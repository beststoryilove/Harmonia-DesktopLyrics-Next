/**
 * 播放位置时钟：本机外推 + 网络校准。
 *
 * 问题背景
 * ────────
 * 播放器端只在 `timeupdate` 事件里推送 `{type:'time'}`，且发送被节流到 **120ms** 一条
 * （`Harmonia/js/main.js` 的 `sendCurrentTimeToDesktop`：`now - lastDesktopLyricsSentAt < 120` 直接 return）。
 * 更糟的是浏览器 `timeupdate` 本身只有约 4Hz（250ms），后台标签页还会被进一步节流到 1Hz 甚至暂停。
 *
 * 如果桌面端「来一条 time 就刷新一次界面」，逐字卡拉OK填充会以 120~250ms 为步长跳变，
 * 观感是明显的卡顿而非连续动画。因此必须由桌面端自己做**本机时钟外推**：
 *
 *   显示位置 = 锚点位置 + (现在时刻 - 锚点时刻) × 速率
 *
 * 每次收到 `time` / `seek` / `status` 都重新打锚点（硬校准），
 * 而 `performance.now()` 单调递增、不受系统时间调整影响，是理想的插值时基。
 *
 * 校准策略（关键取舍）
 * ──────────────────
 * 朴素的「每次收到 time 就硬设锚点」在抖动网络下会让进度**倒退**（视觉上歌词回跳）。
 * 这里区分两种偏差：
 *   - 小偏差（|diff| <= smoothThresholdMs）：认为是对齐噪声，按指数滑动微调，
 *     既不跳变也不倒退（允许轻微加速/减速追上）。
 *   - 大偏差（|diff| > snapThresholdMs，或发生 seek / 换曲）：直接硬重锚，
 *     此时"追上真实播放位置"比"平滑"更重要。
 *   两者之间为死区：偏差不大不动，避免持续微抖。
 */

/** 默认参数。 */
export const DEFAULT_CLOCK_OPTIONS = Object.freeze({
  /** 小于该偏差走平滑微调（毫秒） */
  smoothThresholdMs: 120,
  /** 大于该偏差直接硬重锚（毫秒） */
  snapThresholdMs: 600,
  /** 平滑系数：每次校准消除偏差的比例 */
  smoothFactor: 0.25,
  /** 速率许可范围（防止异常 rate 导致进度飞走） */
  minRate: 0.25,
  maxRate: 4,
  /** 位置上限兜底（毫秒），超过则钳制 */
  maxPositionMs: 24 * 3600 * 1000,
});

/**
 * 播放位置时钟。
 *
 * 时间单位统一为**毫秒**（内部），`positionSec()` 提供秒的便捷读取。
 */
export class PlaybackClock {
  /**
   * @param {object} [options] 覆盖默认参数
   * @param {() => number} [options.now] 单调时钟源（测试可注入）
   */
  constructor(options = {}) {
    this.options = { ...DEFAULT_CLOCK_OPTIONS, ...options };
    this._now = typeof options.now === 'function' ? options.now : () => performance.now();

    /** 锚点：锚定时的播放位置（毫秒） */
    this.anchorPositionMs = 0;
    /** 锚点：锚定时读取的单调时钟值（毫秒） */
    this.anchorStampMs = this._now();

    /** 当前速率（1 = 正常播放） */
    this.rate = 1;
    /** 是否处于播放状态 */
    this.playing = false;
    /** 媒体总时长（毫秒），未知为 null */
    this.durationMs = null;

    /** 统计：便于诊断同步质量 */
    this.stats = {
      samples: 0,
      snaps: 0,
      smooths: 0,
      ignored: 0,
      lastDriftMs: 0,
      maxAbsDriftMs: 0,
    };
  }

  /**
   * 当前外推位置（毫秒）。
   *
   * 暂停时位置不随时间推进（返回锚点位置）。
   *
   * @returns {number} 毫秒
   */
  positionMs() {
    const elapsed = this._now() - this.anchorStampMs;
    const advanced = this.playing ? elapsed * this.rate : 0;
    let position = this.anchorPositionMs + advanced;
    if (!Number.isFinite(position) || position < 0) position = 0;
    if (position > this.options.maxPositionMs) position = this.options.maxPositionMs;
    if (this.durationMs !== null && position > this.durationMs) {
      // 不钳制到 duration：播放器可能在末尾有静音尾巴，钳制会造成"卡在最后一句"
      return position;
    }
    return position;
  }

  /** @returns {number} 当前外推位置（秒） */
  positionSec() {
    return this.positionMs() / 1000;
  }

  /** 硬重锚到指定位置。 */
  _anchor(positionMs) {
    this.anchorPositionMs = Math.max(0, Number(positionMs) || 0);
    this.anchorStampMs = this._now();
  }

  /**
   * 用一条播放器位置样本校准时钟。
   *
   * @param {number} reportedMs 播放器报告的位置（毫秒）
   * @param {object} [context] 上下文
   * @param {boolean} [context.hard=false] 强制硬重锚（seek / 换曲 / 首次同步）
   * @returns {{action: 'snap'|'smooth'|'ignore', driftMs: number}} 本次校准动作与偏差
   */
  sync(reportedMs, context = {}) {
    const reported = Number(reportedMs);
    if (!Number.isFinite(reported) || reported < 0) {
      return { action: 'ignore', driftMs: 0 };
    }

    this.stats.samples += 1;

    if (context.hard === true) {
      this._anchor(reported);
      this.stats.snaps += 1;
      this.stats.lastDriftMs = 0;
      return { action: 'snap', driftMs: 0 };
    }

    const current = this.positionMs();
    const drift = reported - current;
    const absDrift = Math.abs(drift);
    this.stats.lastDriftMs = drift;
    this.stats.maxAbsDriftMs = Math.max(this.stats.maxAbsDriftMs, absDrift);

    // 大偏差或明显倒退：硬重锚
    if (absDrift > this.options.snapThresholdMs) {
      this._anchor(reported);
      this.stats.snaps += 1;
      return { action: 'snap', driftMs: drift };
    }

    // 死区：不动
    if (absDrift <= 16) {
      this.stats.ignored += 1;
      return { action: 'ignore', driftMs: drift };
    }

    // 小偏差：平滑追赶（消除部分偏差，不产生可见跳变）
    if (absDrift <= this.options.smoothThresholdMs) {
      const target = current + drift * this.options.smoothFactor;
      this._anchor(target);
      this.stats.smooths += 1;
      return { action: 'smooth', driftMs: drift };
    }

    // 介于平滑阈值与硬重锚阈值之间：直接重锚，但保留极小过渡
    this._anchor(reported - drift * 0.15);
    this.stats.snaps += 1;
    return { action: 'snap', driftMs: drift };
  }

  /**
   * 设置播放/暂停状态。
   *
   * 状态切换会先固化当前位置再改变速率，避免在错误的位置上继续外推。
   *
   * @param {boolean} playing 是否播放中
   * @param {number} [reportedMs] 同时报告的当前位置（毫秒）
   */
  setPlaying(playing, reportedMs) {
    const frozen = this.positionMs();
    this._anchor(Number.isFinite(Number(reportedMs)) ? Number(reportedMs) : frozen);
    this.playing = Boolean(playing);
    this.rate = this.playing ? 1 : 0;
  }

  /**
   * 设置速率（如倍速播放）。
   *
   * @param {number} rate 速率
   * @param {number} [reportedMs] 同时报告的位置
   */
  setRate(rate, reportedMs) {
    const frozen = this.positionMs();
    this._anchor(Number.isFinite(Number(reportedMs)) ? Number(reportedMs) : frozen);
    const value = Number(rate);
    if (Number.isFinite(value) && value > 0) {
      this.rate = Math.min(this.options.maxRate, Math.max(this.options.minRate, value));
    }
  }

  /**
   * 设置媒体总时长。
   *
   * @param {number} durationSec 秒
   */
  setDuration(durationSec) {
    const value = Number(durationSec);
    this.durationMs = Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : null;
  }

  /**
   * 处理 seek：强制重锚。
   *
   * @param {number} positionSec 目标位置（秒）
   */
  seek(positionSec) {
    const value = Number(positionSec);
    if (!Number.isFinite(value)) return;
    this._anchor(Math.round(value * 1000));
    this.stats.snaps += 1;
  }

  /** 复位到初始状态（换曲时调用）。 */
  reset(positionMs = 0) {
    this._anchor(positionMs);
    this.playing = false;
    this.rate = 1;
    this.durationMs = null;
    this.stats = {
      samples: 0,
      snaps: 0,
      smooths: 0,
      ignored: 0,
      lastDriftMs: 0,
      maxAbsDriftMs: 0,
    };
  }

  /**
   * 诊断快照。
   *
   * @returns {object} 当前状态与统计
   */
  snapshot() {
    return {
      positionMs: Math.round(this.positionMs()),
      playing: this.playing,
      rate: this.rate,
      durationMs: this.durationMs,
      stats: { ...this.stats, maxAbsDriftMs: Math.round(this.stats.maxAbsDriftMs) },
    };
  }
}

export default PlaybackClock;
