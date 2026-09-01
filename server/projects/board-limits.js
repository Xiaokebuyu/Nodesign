/**
 * server/projects/board-limits.js — board.json 的容量常数（2026-08-23 拆出）
 * board-store（写盘前查字节数）和 board-sanitize（逐类计数）都要，单独一份免循环依赖。
 */
export const DEFAULT_BOARD_SIZE = { w: 4000, h: 2600 };
export const MAX_BOARD_BYTES = 2 * 1024 * 1024;   // 08-25 放大（板是整读整写 JSON，这是失控兜底不是风格闸）
export const MAX_OBJECTS = 8000;
export const MAX_ZONES = 200;
// 关系线上限。取值理由：一块板上人能看懂的线远少于这个数，1000 是防脱缰
// （agent 循环里连画）的闸门，不是设计目标。超了直接不收，不做淘汰 ——
// 静默丢最旧的会让"我明明画了"变成玄学。
export const MAX_BINDINGS = 4000;
export const MAX_LANES = 60;      // 线（lane 注册表）：几十条线的脑图已是极限读感
export const MAX_SHEETS = 200;    // 纸（sheet 注册表，2026-08-29 纸范式）：一纸一屏，200 张已是长篇连载量级
/**
 * 栈（stack 注册表，2026-09-01 叠纸）：一摞纸。栈是横向排开的，一块板上并排
 * 几十摞已经翻不过来了；纸的上限仍是 MAX_SHEETS，栈只管有几摞。
 */
export const MAX_STACKS = 60;
