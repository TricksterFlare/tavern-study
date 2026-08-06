'use client';

// 🔖 触发配置——世界书条目"怎么上场"的那一撮字段(关键词/装在哪儿/是不是角色卡/常驻/
// 只认在场角色/角色卡专属的酒馆高级字段),从 DeskDrawers.tsx 的 LoreRowView(打字桌·世界书浮窗)
// 里抽出来,书架的新建/编辑表单(page.tsx)现在也要用同一份 UI——两头改的是同一行 memories,
// 字段长一个样、校验口径也长一个样,不该各画一套。
//
// 正文不归这个组件管:书架和浮窗各自已经有自己的正文输入框(书架是表单最后那个大 textarea,
// 浮窗是 LoreRowView 里紧挨着的那个),这里从头到尾没有 content。
//
// 样式常量(inputStyle/fieldLabelStyle/btnGhostStyle)原来是 DeskDrawers.tsx 里的小料,
// 那边继续从这儿 import 回去用(它自己还有大片跟世界书无关的地方在用 inputStyle/btnGhostStyle),
// 不留第二份——谁改样式只用改这一处。

import { useState } from 'react';

export type CharacterFields = {
  description?: string; personality?: string; scenario?: string; mes_example?: string;
  main_prompt?: string; post_history_instructions?: string;
};

export type LorePosition = 'before' | 'after' | 'char';
export type LoreTriggerMode = 'scan' | 'presence';

// 受控组件的值形状:keysText 是原始草稿文本(顿号/逗号分隔,没切过),presenceOnly 是
// trigger_mode==='presence' 的布尔化——两个调用方都是先拿一行/一条详情摊平成这个形状再受控编辑,
// 保存前再用下面两个 helper 收回落库形状。
export type LoreTriggerValue = {
  keysText: string;
  position: LorePosition;
  isChar: boolean;
  constant: boolean;
  presenceOnly: boolean;
  fields: CharacterFields;
};

// 新建态默认值:跟 D1 memories 表 lore_* 列的 DEFAULT 完全对齐(examples/cloudflare/schema/init.sql)——
// keys=[]/position='before'/is_char=0/constant=0/trigger_mode='scan'/fields='{}'。
export const DEFAULT_LORE_TRIGGER: LoreTriggerValue = {
  keysText: '', position: 'before', isChar: false, constant: false, presenceOnly: false, fields: {},
};

// keysText 草稿 → 落库数组:顿号、中英文逗号都认,掐两头空白,丢空项。
export function triggerKeysFromText(text: string): string[] {
  return text.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
}

// trigger_mode 落库口径统一在这一处:'presence' 只对角色卡有意义,取消勾"是角色卡"时
// 一并落回 'scan',免得留下一张"非角色卡却标着只认在场名单"的行——那一列对普通世界书条目
// 根本不看,存着只会误导下一个读库的人。两个保存路径(浮窗 PUT / 书架 POST·PUT)共用这份实现。
export function triggerModeForSave(isChar: boolean, presenceOnly: boolean): LoreTriggerMode {
  return isChar && presenceOnly ? 'presence' : 'scan';
}

export const inputStyle: React.CSSProperties = {
  fontSize: 13, color: 'var(--ink-body)', background: 'var(--card-bg)', border: '1px solid var(--line-soft)',
  borderRadius: 10, padding: '8px 12px', fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box',
};
export const btnGhostStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--ink-body)', background: 'var(--card-bg)', border: '1px dashed var(--dash-line)',
  padding: '7px 14px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
};
// 字段标题:这几个编辑框原来全靠 placeholder 说自己是谁——一填字提示就消失,回头再看就是
// 一排没名字的框。占位提示留着当例子,标题才是那个不会消失的名牌。
export const fieldLabelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--ink2)', marginBottom: 4 };

export function LoreTriggerFields({ value, onChange }: {
  value: LoreTriggerValue;
  onChange: (patch: Partial<LoreTriggerValue>) => void;
}) {
  // 折叠态只是"这一刻要不要看见"的展示开关,不是数据草稿——留在组件内部,不用上提给调用方。
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={fieldLabelStyle}>触发关键词<span style={{ marginLeft: 6, opacity: 0.8 }}>正文里出现这些词,这张卡才上场（跟书架的「标签」没有关系）</span></div>
        <input value={value.keysText} onChange={(e) => onChange({ keysText: e.target.value })} placeholder="比如：裴瑾、瑾（顿号或逗号分隔）" style={inputStyle} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ ...fieldLabelStyle, marginBottom: 0 }}>装在哪儿</span>
        <select value={value.position} onChange={(e) => onChange({ position: e.target.value as LorePosition })} style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}>
          <option value="before">前置</option>
          <option value="after">后置</option>
          <option value="char">角色卡位</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink2)' }}>
          <input type="checkbox" checked={value.isChar} onChange={(e) => onChange({ isChar: e.target.checked })} /> 是角色卡
        </label>
        {!value.isChar && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink2)' }}><input type="checkbox" checked={value.constant} onChange={(e) => onChange({ constant: e.target.checked })} /> 常驻（无需关键词）</label>}
        {value.isChar && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink2)' }}><input type="checkbox" checked={value.presenceOnly} onChange={(e) => onChange({ presenceOnly: e.target.checked })} /> 只认状态板「在场角色」</label>}
      </div>
      {value.isChar && value.presenceOnly && (
        <div style={{ fontSize: 11, color: 'var(--ink2)', lineHeight: 1.6 }}>
          这张卡不再扫正文,只在状态板的「在场角色」里出现她时才上场。<b>单字名/容易撞词的名字用这个</b>——
          中文没有词边界,「露」会被"暴露/露出"勾出来,「寻」会被"寻找/寻常"勾出来。
        </div>
      )}
      {value.isChar && (
        <div style={{ borderTop: '1px dashed var(--dash-line)', paddingTop: 8 }}>
          <button type="button" onClick={() => setShowAdvanced((v) => !v)} style={{ ...btnGhostStyle, fontSize: 11.5 }}>{showAdvanced ? '收起酒馆高级字段 ▲' : '酒馆高级字段（可选）▼'}</button>
          {showAdvanced && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
              <textarea value={value.fields.description || ''} onChange={(e) => onChange({ fields: { ...value.fields, description: e.target.value } })} placeholder="Description（留空则自动使用上面的完整正文）" style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} />
              <textarea value={value.fields.personality || ''} onChange={(e) => onChange({ fields: { ...value.fields, personality: e.target.value } })} placeholder="Personality（可选）" style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }} />
              <textarea value={value.fields.scenario || ''} onChange={(e) => onChange({ fields: { ...value.fields, scenario: e.target.value } })} placeholder="Scenario（可选）" style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }} />
              <textarea value={value.fields.mes_example || ''} onChange={(e) => onChange({ fields: { ...value.fields, mes_example: e.target.value } })} placeholder="Example Messages（可选）" style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} />
              <textarea value={value.fields.main_prompt || ''} onChange={(e) => onChange({ fields: { ...value.fields, main_prompt: e.target.value } })} placeholder="角色 Main Prompt 覆盖（预留）" style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }} />
              <textarea value={value.fields.post_history_instructions || ''} onChange={(e) => onChange({ fields: { ...value.fields, post_history_instructions: e.target.value } })} placeholder="角色 Post-History Instructions（预留）" style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
