import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Market } from '../lib/api-market.js';
import { sheetClassOf } from './home-sheets.js';
import { timeAgo } from '../lib/helpers.js';
import { t } from '../lib/i18n.js';

/**
 * 首页项目区里混进来的「别人的」（2026-09-08 站主：所有用户的项目区都该看见一些别人的项目，
 * 带特殊标记、我手动筛选，数量随自己项目数增多而减少）。
 *
 * 它不是项目，是市场上被站主加精的发布条目（skill + 截图），点开进 /market/:id 看详情、装 skill，
 * 不进任何工作台 —— 所以归属校验一行不动，也不会跟自己的项目混进同一个 store。
 * 数量由服务端算（max(0, 6 - 自己的项目数)），前端只画拿到的那几张；0 个项目的新用户满屏都是它，
 * 六个项目以后一张不剩。
 *
 * 纸用设计那种横格本，右上角贴一张「别人的」签，跟「接着做」那张同一副纸签，颜色换成墨色。
 */
export function useFeatured(enabled) {
  const [featured, setFeatured] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    // 拉不到（桌面版没登录站点 / 站点没开市场）就当没有：首页不为它报错
    Market.featured().then(({ items = [] }) => { if (!dead) setFeatured(items); }).catch(() => {});
    return () => { dead = true; };
  }, [enabled]);
  return featured;
}

export function FeaturedCard({ pub, tilt }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`ndd-card ${sheetClassOf('design')}`}>
      <Link to={`/market/${pub.id}`} style={{ '--rot': tilt }}>
        {failed ? (
          <div className="ndd-shot empty" style={{ aspectRatio: '1.6' }} />
        ) : (
          <div className="ndd-shot" style={{ aspectRatio: '1.6' }}>
            <img src={Market.imageUrl(pub.id, 0)} alt={pub.title} loading="lazy" onError={() => setFailed(true)} />
          </div>
        )}
        <div className="t">{pub.title}</div>
        <div className="m">
          <span>{t('{name} 的 skill', { name: pub.author?.username || '' })}</span>
          <span>{timeAgo(pub.createdAt)}</span>
        </div>
      </Link>
      <span className="pin" />
      <span className="last peer">{t('别人的')}</span>
    </div>
  );
}
