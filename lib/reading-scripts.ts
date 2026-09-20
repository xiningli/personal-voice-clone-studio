// Emotion tags and reading scripts shared by the server (prompt queue) and the client (session UI).
import type { Language } from "./types";

export interface ReadingScript {
  id: string;
  label: string;
  emotion: string;
  text: string;
}

/** Emotions the owner can read a reference clip with. The id is stored on the profile. */
export const EMOTIONS: { id: string; label: string; hint: string }[] = [
  { id: "neutral", label: "平静 / Neutral", hint: "自然、放松，像平时说话。" },
  { id: "warm", label: "温暖 / Warm", hint: "亲切、带笑意，像在欢迎一位朋友。" },
  { id: "happy", label: "开心 / Happy", hint: "明亮、上扬，语速可以稍快。" },
  { id: "excited", label: "兴奋 / Excited", hint: "有能量、有起伏，重音明显。" },
  { id: "serious", label: "严肃 / Serious", hint: "平稳、克制、字字清楚。" },
  { id: "calm", label: "沉稳 / Calm", hint: "低、慢、句间留空。" },
  { id: "curious", label: "好奇 / Curious", hint: "带疑问，句尾轻轻上扬。" },
  { id: "sad", label: "低落 / Sad", hint: "轻、慢、气息多一点。" },
  { id: "surprised", label: "惊讶 / Surprised", hint: "突然、拔高、停顿再接。" },
  { id: "tender", label: "温柔 / Tender", hint: "轻声、柔和，像哄人。" },
];

export const READING_SCRIPTS: Record<"en" | "zh", ReadingScript[]> = {
  en: [
    { id: "en-neutral-lecture", label: "Lecture", emotion: "neutral", text: "Welcome to today's lesson. We're going to explore a concept that comes up again and again in this field. By the end of this session, you should feel comfortable applying it on your own. Let's start with the basics and build from there." },
    { id: "en-neutral-technical", label: "Technical walkthrough", emotion: "neutral", text: "In this section we'll examine the function step by step. First, notice how the input is validated before any processing occurs. Then the data is transformed using a mapping operation. Finally, the result is returned to the caller with appropriate error handling." },
    { id: "en-warm-greeting", label: "Greeting a visitor", emotion: "warm", text: "Hi, come on in, I'm really glad you found your way here. Make yourself comfortable. I've been looking forward to showing you around, so take your time, and ask me anything that catches your eye." },
    { id: "en-happy-intro", label: "Favourite topic", emotion: "happy", text: "Oh, this is one of my favourite topics! There's something so satisfying about watching all these pieces click into place. I think you're going to love this part. Ready? Let's dive in!" },
    { id: "en-excited-demo", label: "It works!", emotion: "excited", text: "Look at this, it actually works! We just trained it for ten minutes and it's already getting the answers right. Can you believe that? Okay, okay, let me show you what's going on under the hood." },
    { id: "en-serious-warning", label: "Common mistake", emotion: "serious", text: "Pay close attention here, because this is where most people go wrong. The order of these two steps matters. If you swap them, the result will look correct, but it will silently be wrong." },
    { id: "en-calm-summary", label: "Calm summary", emotion: "calm", text: "Let's take a moment to review what we've covered. The key takeaway is that each component serves a specific purpose within the larger system. Once you understand those roles, the architecture becomes much easier to reason about." },
    { id: "en-curious-question", label: "Posing a question", emotion: "curious", text: "So here's a question for you. What do you think happens if we double the learning rate? Does it train twice as fast, or does something else go wrong? Take a guess before we run it." },
    { id: "en-sad-reflection", label: "Reflection", emotion: "sad", text: "I'll be honest, this one didn't go the way I hoped. We spent weeks on it and the results were barely better than the baseline. That's part of the work, though, and I'd rather tell you that than pretend." },
    { id: "en-surprised-result", label: "Unexpected result", emotion: "surprised", text: "Wait, what? That can't be right. The smaller model just beat the larger one? Hold on, let me run that again, because if this holds up it changes the whole plan." },
    { id: "en-tender-encourage", label: "Encouragement", emotion: "tender", text: "Hey, it's okay. Everyone gets stuck on this part the first time, and it doesn't mean anything about you. Take a breath, we'll go through it slowly together, one line at a time." },
  ],
  zh: [
    { id: "zh-neutral-lecture", label: "课堂讲授", emotion: "neutral", text: "大家好，欢迎来到今天的课程。今天我们要讲的这个概念，在后面的学习里会反复出现。我会先从最基本的例子讲起，然后一步一步往上搭，等这节课结束的时候，你应该就能自己动手用它了。" },
    { id: "zh-neutral-technical", label: "技术讲解", emotion: "neutral", text: "我们来看这段代码。首先，函数在处理之前会先校验输入是否合法；接着，数据会经过一次映射变换；最后，结果连同错误信息一起返回给调用方。注意这里每一步的顺序都不能颠倒。" },
    { id: "zh-warm-greeting", label: "欢迎来访", emotion: "warm", text: "你好呀，快请进。很高兴你能找到这里，随便看看，不用拘束。我一直想带人转一转这个地方，你慢慢来，看到什么感兴趣的，直接问我就行。" },
    { id: "zh-happy-intro", label: "最喜欢的话题", emotion: "happy", text: "哈，这可是我最喜欢讲的一部分！看着这些零散的东西一块一块拼起来，特别有成就感。我觉得你也会喜欢的。准备好了吗？我们开始吧！" },
    { id: "zh-excited-demo", label: "跑通了！", emotion: "excited", text: "你看你看，真的跑通了！我们才训练了十分钟，它就已经能答对了。太厉害了吧？好好好，别急，我来给你讲讲底下到底发生了什么。" },
    { id: "zh-serious-warning", label: "常见错误", emotion: "serious", text: "这里请务必注意，大多数人都是在这一步出错的。这两个步骤的顺序不能换。换了之后结果看起来是对的，但其实已经悄悄错了。" },
    { id: "zh-calm-summary", label: "总结回顾", emotion: "calm", text: "好，我们来回顾一下今天讲的内容。核心只有一句话：每个模块都有自己明确的职责。当你理解了各个部分各自负责什么，整个系统的结构就会清晰很多。" },
    { id: "zh-curious-question", label: "抛出问题", emotion: "curious", text: "那我考你一个问题。如果我们把学习率调成两倍，会怎么样？是训练快一倍，还是会出别的问题？先猜一下，猜完我们再跑一遍看看。" },
    { id: "zh-sad-reflection", label: "复盘", emotion: "sad", text: "说实话，这一次没有做成我想要的样子。我们花了好几个星期，结果只比基线好了一点点。不过这也是工作的一部分，我宁愿直接告诉你，也不想装作一切顺利。" },
    { id: "zh-surprised-result", label: "意外结果", emotion: "surprised", text: "等等，什么？这不对吧。小模型居然把大模型给赢了？你先别动，我再跑一遍。要是这个结果站得住，那整个计划都得改。" },
    { id: "zh-tender-encourage", label: "安慰鼓励", emotion: "tender", text: "没关系的，真的。每个人第一次学到这里都会卡住，这不说明你有什么问题。先喘口气，我们一起慢慢来，一行一行地看。" },
  ],
};

export const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
];

/** Reading scripts for a language and emotion (falls back to all scripts of that language). */
export function scriptsFor(language: Language, emotion: string): ReadingScript[] {
  const all = language === "zh" ? READING_SCRIPTS.zh : READING_SCRIPTS.en;
  const matching = all.filter((s) => s.emotion === emotion);
  return matching.length ? matching : all;
}

export function emotionLabel(id?: string): string {
  return EMOTIONS.find((e) => e.id === id)?.label ?? id ?? "";
}

export function emotionHint(id?: string): string {
  return EMOTIONS.find((e) => e.id === id)?.hint ?? "";
}
