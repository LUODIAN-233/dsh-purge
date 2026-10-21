const HOST_PROMPT_FILE = "dsh-system-prompt/lib/index.js";

function hostPromptFlags(text) {
  const body = String(text || "");
  return {
    body,
    identityMarked: body.includes("[dsh-purge] identity stripped"),
    injectMarked: body.includes("[dsh-purge] complete prompt keeps waterfall inject")
      || body.includes("[dsh-purge] complete prompt keeps inject"),
    identityLeft: body.includes("You are an AI agent powered by DeepSeek Harness."),
    dropsInject: body.includes("transformed.sections : [completeSection]"),
    assemble: body.includes("system-prompt/assemble"),
  };
}

/** 重启前看系统提示词文件：标记写上了，或者当前原文里已经没有那两处旧拦截。 */
export function hostPromptKeepsInject(text) {
  const flags = hostPromptFlags(text);
  if (flags.identityMarked && flags.injectMarked) return true;
  // 空文件或不是这份模块，不能当成已经洗过。
  if (!flags.assemble) return false;
  return !flags.identityLeft && !flags.dropsInject;
}

/** 宿主清洗没过时，指出是哪条补丁、哪个文件。空数组表示已通过。 */
export function hostPromptCleanGaps(text) {
  const flags = hostPromptFlags(text);
  if (hostPromptKeepsInject(flags.body)) return [];
  if (!flags.assemble) {
    return [`${HOST_PROMPT_FILE} 缺少 system-prompt/assemble，清洗标记对不上`];
  }
  const gaps = [];
  if (!flags.identityMarked && flags.identityLeft) {
    gaps.push(`#25 HARNESS_IDENTITY_STRIP 未写入 ${HOST_PROMPT_FILE}（身份句还在）`);
  }
  if (!flags.injectMarked || flags.dropsInject) {
    const why = flags.dropsInject
      ? "仍保留 sections: completeSection === void 0 ? transformed.sections : [completeSection]"
      : "缺少 keeps inject 标记";
    gaps.push(`#40 COMPLETE_PROMPT_KEEP_INJECT 未写入 ${HOST_PROMPT_FILE}（${why}）`);
  }
  if (!gaps.length) gaps.push(`${HOST_PROMPT_FILE} 未通过宿主清洗检查`);
  return gaps;
}
