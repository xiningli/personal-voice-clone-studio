// Line bank for sampled arena rounds. Categories mirror what the digital human and the
// teaching lines actually say; lines are sampled at random so the listener does not
// pick the sentence that flatters one instruction.

export interface LineCategory {
  id: string;
  label: string;
  lines: string[];
}

export const LINE_BANK: LineCategory[] = [
  {
    id: "lecture",
    label: "Lecture",
    lines: [
      "Hello everyone. Today we are going to talk about one of the most fundamental ideas in programming: variables.",
      "Welcome back. Last time we covered loops, and today we build on that with functions.",
      "Before we start, let's recall what a tensor is, because everything today depends on it.",
      "Attention lets every token look at every other token in the sequence at the same time.",
      "There are three parts to this lesson: the intuition, the math, and a worked example.",
      "Let's begin with the simplest possible case and only add complexity once that is clear.",
    ],
  },
  {
    id: "greeting",
    label: "Greeting",
    lines: [
      "Hi, welcome in. I'm glad you found your way here. Take a look around, and ask me anything that catches your eye.",
      "Hey, good to see you. Come in, make yourself comfortable.",
      "Welcome. This is the space I built. Feel free to wander, and I'll be right here if you have questions.",
      "Oh, hello! I wasn't expecting anyone this early. Come on in.",
      "Nice to meet you. I'm the person behind all of this, and I'd love to show you around.",
    ],
  },
  {
    id: "question",
    label: "Question",
    lines: [
      "So here's a question for you. What do you think happens if we double the learning rate?",
      "Quick check: why does the loss go down but the accuracy stay flat?",
      "What would you try first if the model started producing nonsense after ten steps?",
      "Can you guess which of these two runs used the smaller batch size?",
      "Here's something to think about: does more data always help?",
    ],
  },
  {
    id: "thinking",
    label: "Thinking aloud",
    lines: [
      "Hmm, that's a good one. Let me think about it for a second. I believe the short answer is yes, but it depends on the data.",
      "Right, so, if I remember correctly, the paper reported that, but I'd want to double check the setup.",
      "Let me see. The first thing that comes to mind is overfitting, though it could also be a data leak.",
      "That's actually harder than it sounds. Give me a moment to work through it.",
      "Okay, so there are two ways to look at this, and I'm not sure which one you're asking about.",
    ],
  },
  {
    id: "explanation",
    label: "Explanation",
    lines: [
      "Think of a variable as a labeled box. The label is the name, and whatever you put inside is the value.",
      "The gradient tells you which direction makes the loss smaller, and the learning rate decides how far you step.",
      "A cache is just memory that remembers answers so you don't have to compute them twice.",
      "Batching means we process many examples at once, which keeps the GPU busy.",
      "Regularization is a way of telling the model: prefer the simpler explanation.",
    ],
  },
  {
    id: "encouragement",
    label: "Encouragement",
    lines: [
      "Hey, it's okay. Everyone gets stuck on this part the first time. We'll go through it slowly together.",
      "You're closer than you think. The bug is small, and you already found where it lives.",
      "That was a good attempt. Let's see what it tells us and adjust from there.",
      "Don't worry about the score today. What matters is that the idea clicked.",
    ],
  },
  {
    id: "summary",
    label: "Summary",
    lines: [
      "So, to wrap up: variables hold values, functions hold behavior, and modules hold both.",
      "The key takeaway is that each component serves one purpose, and the architecture follows from that.",
      "That's the whole idea. Next time we'll see what breaks when the data isn't clean.",
      "In short, attention is a weighted average, and the weights are learned.",
    ],
  },
];

export function pickLine(categoryId: string): { category: LineCategory; text: string } {
  const pool = categoryId === "any" ? LINE_BANK : LINE_BANK.filter((c) => c.id === categoryId);
  const category = pool[Math.floor(Math.random() * pool.length)] ?? LINE_BANK[0];
  const text = category.lines[Math.floor(Math.random() * category.lines.length)];
  return { category, text };
}

/**
 * Sample `n` distinct items with probability inversely proportional to how often each was
 * already used, so coverage stays balanced across the pool (a rarely-tested instruction is
 * drawn more often than one that already has many rounds).
 */
export function sampleBalanced<T>(items: T[], counts: (item: T) => number, n: number): T[] {
  const remaining = [...items];
  const picked: T[] = [];
  while (picked.length < n && remaining.length > 0) {
    const weights = remaining.map((it) => 1 / (1 + counts(it)));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= weights[idx];
      if (r <= 0) break;
    }
    idx = Math.min(idx, remaining.length - 1);
    picked.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return picked;
}
