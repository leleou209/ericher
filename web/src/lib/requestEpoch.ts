/** 异步结果只允许写回发起它的当前上下文。 */
export class RequestEpoch {
  private generation = 0;
  next(): number { return ++this.generation; }
  current(ticket: number): boolean { return ticket === this.generation; }
  invalidate(): void { this.generation++; }
}
