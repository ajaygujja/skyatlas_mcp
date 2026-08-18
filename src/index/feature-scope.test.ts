import { describe, expect, it } from 'vitest';
import { featureOfFile } from './feature-scope.js';

// Feature attribution is a path convention, not extracted data (Working Rule 8):
// these cases pin which layouts carry a feature and which carry none.
describe('featureOfFile', () => {
  it('reads the segment below a features/ directory', () => {
    expect(featureOfFile('apps/app/lib/features/forms/presentation/form_screen.dart')).toBe(
      'forms',
    );
  });

  it('accepts the singular and modules spellings', () => {
    expect(featureOfFile('lib/feature/billing/view.dart')).toBe('billing');
    expect(featureOfFile('lib/src/modules/orders/view.dart')).toBe('orders');
  });

  it('attributes a nested feature to the innermost one containing the file', () => {
    expect(featureOfFile('lib/features/shell/features/tabs/view.dart')).toBe('tabs');
  });

  it('has no feature outside a feature directory', () => {
    expect(featureOfFile('lib/core/router/app_router.dart')).toBeUndefined();
  });

  it('does not read a file named like a feature directory as one', () => {
    expect(featureOfFile('lib/features.dart')).toBeUndefined();
  });
});
