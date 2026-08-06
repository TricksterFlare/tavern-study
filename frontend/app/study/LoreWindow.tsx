'use client';

// 世界书浮窗——顶栏「世」按钮开的就是它。
//
// 为什么它是浮窗而不是文具盒里的一个标签页:判据是"这条设置改的是内容本身,还是生成时机器怎么
// 处理它"——触发关键词、是否角色卡、装在哪儿、只认在场、启不启用、核心记忆,全都是内容本身,该跟
// 内容走;配方/积木/正则/导入才是生成管线的处理方式,留在文具盒。
//
// 浮窗只做"快改"(调触发词、翻开关、看上一楼命中了谁),精修仍然回书架——同一份数据两个入口,
// 没有正副本之分(只有一张表,不存在两头写歪的可能)。
//
// 布局照抄同屏的时光带/状态板浮窗:absolute 贴在头栏下方,top/maxHeight 由 headerH/footerH 量出来,
// 自身 overflow-y-auto,实底 + z-[1](压过 HeatBg 那层 z:0 的渐变纱罩,理由见 TypingDesk.tsx 小纸条
// 抽屉那段注释;不许够到底栏 z-[2]/头栏 z-[8])。

import { useEffect, useState } from 'react';
import { CoreTab, LoreTab } from './DeskDrawers';

export default function LoreWindow({
  base, envOk, project, headerH, footerH, onDirtyChange, onClose, closeArmed,
}: {
  base: string; envOk: boolean; project: string;
  headerH: number; footerH: number;
  // 脏位上报:核心记忆的分块草稿、条目行内编辑器,都是"不点保存就不落库"的中间态。这两个标签页
  // 住在浮窗里,没有抽屉壳的 guardedClose 两段确认保着——不报上去的话,点「关闭」/去开时光带/
  // 去开状态板,填了一半的字就没了。
  onDirtyChange?: (dirty: boolean) => void;
  // 关闭走挂载方的两段确认(requestLoreClose):有草稿时第一次点只是把话说出来。closeArmed 是
  // "已经问过一次、正在等第二下"的状态,只用来改按钮文案——判断和计时都在挂载方,这里不复制一份。
  onClose: () => void;
  closeArmed?: boolean;
}) {
  // 核心记忆置顶,但默认收起:它是"必须有"的总纲,不是"每次都要看"的东西——打开浮窗十有八九是
  // 来调某张卡的触发词的,核心记忆摊开着只是把条目列表挤到下面去。
  const [coreOpen, setCoreOpen] = useState(false);
  const [coreDirty, setCoreDirty] = useState(false);
  const [loreDirty, setLoreDirty] = useState(false);
  const dirty = coreDirty || loreDirty;
  // 照 DeskDrawers 里那几个标签页的手法:卸载时清 false,不留幽灵脏位——浮窗一关整棵子树
  // 就没了,草稿也跟着没了,再让外面挂着"有草稿"会把下一次开时光带永久卡住。
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  return (
    <div
      className="absolute left-0 right-0 z-[1] border-b border-line-soft bg-card shadow-sm px-6 py-4 max-[760px]:px-3.5 overflow-y-auto"
      style={{ top: headerH, maxHeight: `calc(100% - ${headerH}px - ${footerH}px)` }}
    >
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div>
            <div className="serc text-sm text-ink-deep">世界书</div>
            <div className="text-[11px] text-ink2 mt-0.5">{project} · 跟书架的「设定+大纲」是同一批东西</div>
          </div>
        </div>

        {/* ── 总纲:核心记忆(置顶) ── */}
        <div className="rounded-2xl border border-line-soft bg-page px-4 py-3 mb-4">
          <button
            onClick={() => setCoreOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 cursor-pointer bg-transparent border-none p-0 text-left"
          >
            <span className="flex items-center gap-2 flex-wrap">
              <span className="serc text-[13px] text-ink-deep">核心记忆</span>
              <span className="text-[10.5px] text-ink2 bg-card rounded-full px-2 py-0.5">总纲 · 常驻</span>
            </span>
            <span className="text-[11px] text-ink2">{coreOpen ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {/* 收起用 display:none 而不是卸载:CoreTab 一卸载,填了一半的核心记忆草稿就没了
              (子组件的 dirty cleanup 还会顺手把脏位清成 false,连提醒都不会有)。折叠只该藏起来。*/}
          <div className="mt-3" style={{ display: coreOpen ? undefined : 'none' }}>
              {/* 核心记忆的数据仍住后端状态表的 desk_core:<项目> 键,没并进 study 条目——它在
                  生成管线里的位置是最前的稳定前缀,普通世界书条目在别处拼接,位置不同,硬合会
                  改变管线结构。这里挪的只是编辑入口。
                  key={project} 同文具盒里的老家法:切项目=整份子树重挂载,旧项目的草稿/在途请求
                  连着组件实例一起作废。*/}
            <CoreTab key={project} base={base} envOk={envOk} project={project} onDirtyChange={setCoreDirty} />
          </div>
        </div>

        {/* ── 条目列表 ── */}
        <LoreTab key={project} base={base} envOk={envOk} project={project} onDirtyChange={setLoreDirty} />

        <div className="flex items-center justify-end gap-3 mt-4">
          {dirty && !closeArmed && <span className="text-[11px] text-ink2">有没保存的编辑</span>}
          <button
            onClick={onClose}
            className="text-xs hover:text-ink-body"
            style={{ color: closeArmed ? '#c0573f' : 'var(--ink2)' }}
          >
            {closeArmed ? '再点一次丢弃并关闭' : '关闭'}
          </button>
        </div>
      </div>
    </div>
  );
}
