import { deliverJobId, dispatchJobId } from './queue.constants';

describe('job ids', () => {
  it('never contains a colon, which BullMQ rejects outright', () => {
    // BullMQ composes its Redis keys with ':' and refuses a custom id
    // containing one — and only at `queue.add` time, so a mocked queue in a
    // unit test would never notice.
    expect(dispatchJobId('24d05bc2-0a69-43b0-9a50-1fc936301468')).not.toContain(
      ':',
    );
    expect(deliverJobId('24d05bc2-0a69-43b0-9a50-1fc936301468')).not.toContain(
      ':',
    );
  });

  it('keeps dispatch and deliver ids distinct for the same uuid', () => {
    expect(dispatchJobId('x')).not.toBe(deliverJobId('x'));
  });
});
