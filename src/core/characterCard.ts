// src/core/characterCard.ts
// 纯解析函数:归一化 SillyTavern 角色卡三种格式(V1 平铺 / V2 / V3)。
// 不碰 D1/env、只吃/吐普通对象——同文件家法照抄 tools/desk.ts 头注释那条:纯函数跟落库分开,
// 前端/测试都能直接对着这个函数跑,不用起一整条服务端链路。
//
// 三种格式:
//   V2: { spec:'chara_card_v2', data:{...} }
//   V3: { spec:'chara_card_v3', data:{...} }
//   V1: 平铺对象,name/description 等字段直接躺在顶层,没有 spec 字段
//
// 容错口径(工单原话):缺字段跳过(不算错,是正常情况)、类型不对忽略该字段并计入 warnings、
// name 缺失(或类型不对/全空白)是唯一的硬错误。不认识的顶层字段一律忽略,warnings 里只记
// 一句"忽略了N个不认识的字段: ..."的汇总,不逐个列——一张卡的自定义扩展字段可能有十几个,
// 逐条报会把 warnings 撑成噪音墙。

function describeType(v: any): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export interface CharacterCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  firstMes: string;
  alternateGreetings: string[];
  // entries 原样透传(数组或 uid 为键的对象都可能出现)——落库时复用 tools/desk.ts 的
  // parseWorldEntries,那边本来就兼容两种形状,这里不用再解一遍。
  characterBook: { entries: any } | null;
}

export type ParseCharacterCardResult =
  | { ok: true; card: CharacterCard; warnings: string[] }
  | { ok: false; error: string };

// V2/V3 规范里已经命名过的顶层字段 + 几个 V1 老卡常见字段——出现了不算"不认识",只是我们不提取。
// 落在这份名单外的键才计入"不认识的字段"汇总,防止随手写的扩展字段每张卡都刷一屏 warnings。
const KNOWN_TOP_KEYS = new Set([
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'system_prompt', 'post_history_instructions', 'alternate_greetings', 'character_book',
  'creator_notes', 'tags', 'creator', 'character_version', 'extensions',
  'assets', 'nickname', 'creator_notes_multilingual', 'source', 'group_only_greetings',
  'creation_date', 'modification_date', 'avatar', 'talkativeness', 'fav',
  'creatorcomment', 'create_date', 'chat', 'metadata',
]);

export function parseCharacterCard(raw: unknown): ParseCharacterCardResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `不是合法的角色卡JSON对象——读到的类型是 ${describeType(raw)}` };
  }

  const warnings: string[] = [];
  let source: Record<string, any>;
  const spec = raw.spec;
  if (spec === 'chara_card_v2' || spec === 'chara_card_v3') {
    if (!isPlainObject(raw.data)) {
      return { ok: false, error: `声明了 spec:${JSON.stringify(spec)} 但 data 字段不是对象——实际收到的是 ${describeType(raw.data)}` };
    }
    source = raw.data;
  } else if (spec !== undefined) {
    return { ok: false, error: `不认识的 spec 字段:${JSON.stringify(spec)}(只认 chara_card_v2/chara_card_v3;不带 spec 字段则按 V1 平铺格式解析)` };
  } else {
    source = raw; // V1:没有 spec,顶层直接就是卡数据
  }

  const nameRaw = source.name;
  if (typeof nameRaw !== 'string' || !nameRaw.trim()) {
    return { ok: false, error: `缺 name 字段(或类型不对/全是空白)——实际收到的是 ${describeType(nameRaw)}` };
  }
  const name = nameRaw.trim();

  // 已知字符串字段统一走这个取法:缺字段(undefined/null)静默给空字符串,不是错误;
  // 类型给错了(比如塞了个数字)才算一个warning——那字段被当成没给,不是硬拒。
  const strField = (key: string): string => {
    const v = source[key];
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') {
      warnings.push(`${key} 类型不对(实际是${describeType(v)}),已忽略`);
      return '';
    }
    return v;
  };

  const description = strField('description');
  const personality = strField('personality');
  const scenario = strField('scenario');
  const mesExample = strField('mes_example');
  const systemPrompt = strField('system_prompt');
  const postHistoryInstructions = strField('post_history_instructions');
  const firstMes = strField('first_mes');

  let alternateGreetings: string[] = [];
  const altRaw = source.alternate_greetings;
  if (altRaw !== undefined && altRaw !== null) {
    if (!Array.isArray(altRaw)) {
      warnings.push(`alternate_greetings 类型不对(实际是${describeType(altRaw)}),已忽略`);
    } else {
      const strings = altRaw.filter((g): g is string => typeof g === 'string');
      if (strings.length !== altRaw.length) warnings.push('alternate_greetings 里混了非字符串项,已跳过那些项');
      alternateGreetings = strings;
    }
  }

  // character_book 容错三档:不给(正常,静默)/给了但形状不对(warn+当没给)/entries本身形状不对
  // (warn+当没给)。entries 内部单条条目的形状容错交给消费方(tools/desk.ts parseWorldEntries),
  // 这里不重复解一遍那套逻辑。
  let characterBook: { entries: any } | null = null;
  const bookRaw = source.character_book;
  if (bookRaw !== undefined && bookRaw !== null) {
    if (!isPlainObject(bookRaw)) {
      warnings.push(`character_book 类型不对(实际是${describeType(bookRaw)}),已忽略`);
    } else if (bookRaw.entries === undefined || bookRaw.entries === null) {
      // 带了 character_book 但没带 entries——静默当没带世界书,不是错误(有的卡就是留了个空壳)。
    } else if (!Array.isArray(bookRaw.entries) && !isPlainObject(bookRaw.entries)) {
      warnings.push(`character_book.entries 类型不对(实际是${describeType(bookRaw.entries)}),已忽略`);
    } else {
      characterBook = { entries: bookRaw.entries };
    }
  }

  const unknownKeys = Object.keys(source).filter((k) => !KNOWN_TOP_KEYS.has(k));
  if (unknownKeys.length > 0) {
    const shown = unknownKeys.slice(0, 10).join('、');
    warnings.push(`忽略了 ${unknownKeys.length} 个不认识的字段: ${shown}${unknownKeys.length > 10 ? ' 等' : ''}`);
  }

  return {
    ok: true,
    warnings,
    card: {
      name, description, personality, scenario, mesExample,
      systemPrompt, postHistoryInstructions, firstMes, alternateGreetings, characterBook,
    },
  };
}
