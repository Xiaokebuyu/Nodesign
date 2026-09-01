/**
 * BoardScreenLayer —— 画布上那两件**屏幕坐标系**的导航件（2026-09-01 拆出）
 *
 * 小地图和目录都不在世界坐标系里：镜头怎么动它们都钉在角上。它们回答的也是同一个
 * 问题 ——「板上有什么、我在哪」。小地图从平面上答（全貌 + 视口框），目录从摞和页
 * 上答（叠起来的东西平面上看不见）。所以两件收在一处，出场条件也共用一份。
 *
 * 出场条件三条：眼睛页不出（截图里不该有 chrome）、开着窗时跟工具栏一起收掉。
 */
import Minimap from './Minimap.jsx';

export default function BoardScreenLayer({
  eyeMode, deckOpen, winDir, touchLane, camera, cam, minimapItems, navPanel,
}) {
  if (eyeMode || deckOpen || winDir) return null;
  /**
   * 小地图在**触屏窄容器**里撤掉（08-28 起，08-29 改判据）：它在那儿占掉左下角
   * 一大块、还压着工具栏，而它回答的那个问题（「我在哪」）翻页器用一句「2/3」
   * 答得更好。
   * ⭐ 判据是**容器宽不是设备档**：平板本来放得下，但聊天卡一开画布区收到 422，
   * 小地图又开始压工具栏 —— 决定放不放得下的从来是容器，不是屏幕。
   * 桌面不动（同样窄的桌面窗口仍然留着它）。
   */
  const showMap = !(touchLane && camera.viewport.w < 560);
  return (
    <>
      {showMap && (
        <Minimap
          bounds={camera.bounds}
          cam={cam}
          viewport={camera.viewport}
          items={minimapItems}
          onJump={(pt) => camera.jumpToPoint(pt)}
        />
      )}
      {navPanel}
    </>
  );
}
