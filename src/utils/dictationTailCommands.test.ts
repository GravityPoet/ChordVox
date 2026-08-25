import { describe, it, expect } from "vitest";
import { matchTailCommand } from "./dictationTailCommands";

describe("matchTailCommand", () => {
  it("should return null for empty or typical text without commands", () => {
    expect(matchTailCommand("")).toBeNull();
    expect(matchTailCommand("今天的天气非常不错，我们要一起去郊游。")).toBeNull();
    expect(matchTailCommand("I am writing typescript code.")).toBeNull();
  });

  it("should match cancel commands at the end of the text", () => {
    expect(matchTailCommand("我们明天去吃烤肉，取消别输出")).toEqual({
      command: "cancel",
      matchedText: "取消别输出",
    });
    expect(matchTailCommand("这句话不要发了，别输出。")).toEqual({
      command: "cancel",
      matchedText: "别输出",
    });
    expect(matchTailCommand("Forget this, do not output!")).toEqual({
      command: "cancel",
      matchedText: "do not output",
    });
    expect(matchTailCommand("不要输出？")).toEqual({
      command: "cancel",
      matchedText: "不要输出",
    });
    expect(matchTailCommand("取消听写")).toEqual({
      command: "cancel",
      matchedText: "取消听写",
    });
  });

  it("should not match command words in the middle of the text", () => {
    expect(matchTailCommand("我取消了那个重要的日程会议。")).toBeNull();
    expect(matchTailCommand("大家重来说明一下项目进度。")).toBeNull();
    expect(matchTailCommand("Please do not output anything here inside the loop.")).toBeNull();
  });

  it("should not fire on bare everyday words at the end of normal dictation", () => {
    // Bare "取消"/"重来"/"cancel"/"redo" are not commands.
    expect(matchTailCommand("帮我把明天的会议取消")).toBeNull();
    expect(matchTailCommand("这个订单我想取消。")).toBeNull();
    expect(matchTailCommand("这个方案只能推倒重来")).toBeNull();
    expect(matchTailCommand("I still need to cancel")).toBeNull();
    expect(matchTailCommand("Please add a redo")).toBeNull();
    expect(matchTailCommand("the app needs a restart")).toBeNull();
  });

  it("should not match command phrases embedded inside longer words", () => {
    // "级别输出" contains "别输出" but has no pause boundary before it.
    expect(matchTailCommand("请调整日志级别输出")).toBeNull();
  });

  it("should match redo commands at the end of the text", () => {
    expect(matchTailCommand("刚才那段解释不准确，重新说")).toEqual({
      command: "redo",
      matchedText: "重新说",
    });
    expect(matchTailCommand("刚才说错了。重新录音。")).toEqual({
      command: "redo",
      matchedText: "重新录音",
    });
    expect(matchTailCommand("This is wrong, start over.")).toEqual({
      command: "redo",
      matchedText: "start over",
    });
    expect(matchTailCommand("算了，重来说吧！")).toEqual({
      command: "redo",
      matchedText: "重来说吧",
    });
    expect(matchTailCommand("重新来过")).toEqual({
      command: "redo",
      matchedText: "重新来过",
    });
  });
});
