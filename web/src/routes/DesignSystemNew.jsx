import { useNavigate } from 'react-router-dom';
import { Upload, Wand2, Check, ArrowLeft } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useGlobalStore } from '../stores/globalStore.js';

const STEPS = [
  { id: 1, icon: Upload, label: '上传素材',  desc: 'PPT / PDF / HTML / 网站 / 截图 / 代码库' },
  { id: 2, icon: Wand2,  label: '流式抽取', desc: 'tokens（颜色/字体/spacing）+ components + layout patterns' },
  { id: 3, icon: Check,  label: '设计师 review + 发布', desc: '调整后发布，新项目可绑定' },
];

/** P6 才真做的"抽取向导"占位页 */
export default function DesignSystemNew() {
  const navigate = useNavigate();
  const showToast = useGlobalStore(s => s.showToast);

  return (
    <AppShell breadcrumb={[
      { label: '设计系统', to: '/design-systems' },
      { label: '新建' },
    ]}>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>

        <button
          onClick={() => navigate('/design-systems')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text4,
            background: 'transparent',
            marginBottom: GAP.lg,
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={13} /> 返回列表
        </button>

        <h1 style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
          color: COLOR.text, marginBottom: GAP.sm,
        }}>新建设计系统</h1>
        <p style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2,
          lineHeight: 1.6, marginBottom: GAP.page,
        }}>
          抽取你已有作品的"风格 / 组件 / 布局 / 节奏"，沉淀为可复用的设计资产。
        </p>

        {/* 三步流程占位 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.lg, marginBottom: GAP.page }}>
          {STEPS.map(s => {
            const Icon = s.icon;
            return (
              <div key={s.id} style={{
                display: 'flex', gap: GAP.lg, alignItems: 'flex-start',
                padding: GAP.xl,
                background: '#fff',
                border: `1px solid ${COLOR.border}`,
                borderRadius: 12,
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: COLOR.bgCard,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.base, fontWeight: 600,
                  color: COLOR.text4,
                }}>{s.id}</div>
                <div style={{ flex: 1 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: GAP.sm,
                    marginBottom: GAP.xs,
                  }}>
                    <Icon size={14} color={COLOR.text4} />
                    <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 500, color: COLOR.text }}>
                      {s.label}
                    </span>
                  </div>
                  <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, lineHeight: 1.5 }}>
                    {s.desc}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{
          padding: `${GAP.lg}px ${GAP.xl}px`,
          background: COLOR.bgCard,
          border: `1px dashed ${COLOR.borderMd}`,
          borderRadius: 12,
          textAlign: 'center',
        }}>
          <div style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, fontWeight: 600,
            color: COLOR.text2, marginBottom: GAP.sm,
          }}>P6 实现</div>
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            lineHeight: 1.6, marginBottom: GAP.lg,
          }}>
            参考系统 = 工作流产品化（不只是抽 token），完整三步落地中。<br />
            前置：HANDOVER §6 风格根因诊断 + style-pipeline 模块。
          </div>
          <button
            onClick={() => showToast('mock：3 秒后会"成功"建一个 DS', 'info')}
            style={{
              padding: `${GAP.sm}px ${GAP.xl}px`,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
              color: COLOR.btnText, background: COLOR.btn,
              border: `1px solid ${COLOR.btn}`,
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            体验 mock 流程（暂占位）
          </button>
        </div>
      </div>
    </AppShell>
  );
}
