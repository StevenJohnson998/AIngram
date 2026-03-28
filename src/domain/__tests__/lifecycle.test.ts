import { transition, canTransition, validEvents, retractReasonForEvent, LifecycleError } from '../lifecycle';
import type { ChunkState, LifecycleEvent } from '../lifecycle';

describe('lifecycle state machine', () => {
  describe('valid transitions from proposed', () => {
    it('OBJECT → under_review', () => {
      expect(transition('proposed', 'OBJECT')).toBe('under_review');
    });
    it('AUTO_MERGE → active', () => {
      expect(transition('proposed', 'AUTO_MERGE')).toBe('active');
    });
    it('WITHDRAW → retracted', () => {
      expect(transition('proposed', 'WITHDRAW')).toBe('retracted');
    });
    it('TIMEOUT → retracted', () => {
      expect(transition('proposed', 'TIMEOUT')).toBe('retracted');
    });
  });

  describe('valid transitions from under_review', () => {
    it('VOTE_ACCEPT → active', () => {
      expect(transition('under_review', 'VOTE_ACCEPT')).toBe('active');
    });
    it('VOTE_REJECT → retracted', () => {
      expect(transition('under_review', 'VOTE_REJECT')).toBe('retracted');
    });
    it('WITHDRAW → retracted', () => {
      expect(transition('under_review', 'WITHDRAW')).toBe('retracted');
    });
    it('TIMEOUT → retracted', () => {
      expect(transition('under_review', 'TIMEOUT')).toBe('retracted');
    });
  });

  describe('valid transitions from active', () => {
    it('DISPUTE → disputed', () => {
      expect(transition('active', 'DISPUTE')).toBe('disputed');
    });
    it('SUPERSEDE → superseded', () => {
      expect(transition('active', 'SUPERSEDE')).toBe('superseded');
    });
  });

  describe('valid transitions from disputed', () => {
    it('DISPUTE_UPHELD → active', () => {
      expect(transition('disputed', 'DISPUTE_UPHELD')).toBe('active');
    });
    it('DISPUTE_REMOVED → retracted', () => {
      expect(transition('disputed', 'DISPUTE_REMOVED')).toBe('retracted');
    });
    it('TIMEOUT → retracted', () => {
      expect(transition('disputed', 'TIMEOUT')).toBe('retracted');
    });
  });

  describe('valid transitions from retracted', () => {
    it('RESUBMIT → proposed', () => {
      expect(transition('retracted', 'RESUBMIT')).toBe('proposed');
    });
  });

  describe('superseded is terminal', () => {
    const events: LifecycleEvent[] = [
      'OBJECT', 'AUTO_MERGE', 'WITHDRAW', 'TIMEOUT', 'VOTE_ACCEPT',
      'VOTE_REJECT', 'DISPUTE', 'SUPERSEDE', 'DISPUTE_UPHELD', 'DISPUTE_REMOVED', 'RESUBMIT',
    ];
    for (const event of events) {
      it(`${event} throws from superseded`, () => {
        expect(() => transition('superseded', event)).toThrow(LifecycleError);
      });
    }
  });

  describe('illegal transitions throw LifecycleError', () => {
    const illegal: [ChunkState, LifecycleEvent][] = [
      ['proposed', 'VOTE_ACCEPT'],
      ['proposed', 'DISPUTE'],
      ['proposed', 'SUPERSEDE'],
      ['proposed', 'RESUBMIT'],
      ['under_review', 'AUTO_MERGE'],
      ['under_review', 'OBJECT'],
      ['under_review', 'DISPUTE'],
      ['under_review', 'RESUBMIT'],
      ['active', 'AUTO_MERGE'],
      ['active', 'VOTE_ACCEPT'],
      ['active', 'WITHDRAW'],
      ['active', 'RESUBMIT'],
      ['disputed', 'AUTO_MERGE'],
      ['disputed', 'VOTE_ACCEPT'],
      ['disputed', 'WITHDRAW'],
      ['retracted', 'AUTO_MERGE'],
      ['retracted', 'VOTE_ACCEPT'],
      ['retracted', 'DISPUTE'],
    ];

    for (const [state, event] of illegal) {
      it(`${event} from ${state} throws`, () => {
        expect(() => transition(state, event)).toThrow(LifecycleError);
      });
    }
  });

  describe('canTransition', () => {
    it('returns true for valid transitions', () => {
      expect(canTransition('proposed', 'AUTO_MERGE')).toBe(true);
      expect(canTransition('active', 'DISPUTE')).toBe(true);
      expect(canTransition('retracted', 'RESUBMIT')).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(canTransition('proposed', 'VOTE_ACCEPT')).toBe(false);
      expect(canTransition('superseded', 'RESUBMIT')).toBe(false);
      expect(canTransition('active', 'AUTO_MERGE')).toBe(false);
    });
  });

  describe('validEvents', () => {
    it('proposed has 4 valid events', () => {
      const events = validEvents('proposed');
      expect(events).toHaveLength(4);
      expect(events).toContain('OBJECT');
      expect(events).toContain('AUTO_MERGE');
      expect(events).toContain('WITHDRAW');
      expect(events).toContain('TIMEOUT');
    });

    it('superseded has no valid events', () => {
      expect(validEvents('superseded')).toHaveLength(0);
    });

    it('retracted has 1 valid event (RESUBMIT)', () => {
      const events = validEvents('retracted');
      expect(events).toEqual(['RESUBMIT']);
    });
  });

  describe('retractReasonForEvent', () => {
    it('VOTE_REJECT → rejected', () => {
      expect(retractReasonForEvent('VOTE_REJECT')).toBe('rejected');
    });
    it('WITHDRAW → withdrawn', () => {
      expect(retractReasonForEvent('WITHDRAW')).toBe('withdrawn');
    });
    it('TIMEOUT → timeout', () => {
      expect(retractReasonForEvent('TIMEOUT')).toBe('timeout');
    });
    it('DISPUTE_REMOVED → rejected', () => {
      expect(retractReasonForEvent('DISPUTE_REMOVED')).toBe('rejected');
    });
    it('AUTO_MERGE → undefined (not a retraction)', () => {
      expect(retractReasonForEvent('AUTO_MERGE')).toBeUndefined();
    });
  });
});
