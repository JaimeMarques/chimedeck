export interface DemoCard {
  shortId: string;
  title: string;
  description: string;
  dueDate?: string;
  amount?: string;
  currency?: string;
}

export const demoCards: DemoCard[] = [
  {
    shortId: 'labcard1',
    title: 'Lab card',
    description: 'Complete UTF-8 description — العربية 🐦',
  },
  {
    shortId: 'labcard2',
    title: 'Lab demo: welcome and reset',
    description:
      'This private board contains ten synthetic demo cards. Guarded reset replaces only the owned lab data; seed recreates these readable examples.',
  },
  {
    shortId: 'labcard3',
    title: 'Lab demo: release checklist',
    description:
      'Review the scope, run the local SDK acceptance, inspect the browser board, and retain the exact revision evidence before publishing the topic branch.',
  },
  {
    shortId: 'labcard4',
    title: 'Lab demo: scheduled review',
    description:
      'Synthetic review appointment with an explicit UTC due date. No email, webhook, payment or external notification is sent by this lab.',
    dueDate: '2030-01-15T14:30:00.123456Z',
  },
  {
    shortId: 'labcard5',
    title: 'Lab demo: cost estimate',
    description:
      'A fictional USD estimate demonstrates the supported decimal amount and currency fields. It is sample data, not a charge or a customer quote.',
    amount: '123.4500',
    currency: 'USD',
  },
  {
    shortId: 'labcard6',
    title: 'Lab demo: accessibility notes',
    description:
      'Use readable titles, keyboard navigation, and clear descriptions. Check that private board access remains limited to the synthetic admin and member.',
  },
  {
    shortId: 'labcard7',
    title: 'Lab demo: compact reads',
    description:
      'List and search summaries omit descriptions by default. Explicit includeDescription or full view returns this complete text; a card read also preserves the complete description.',
  },
  {
    shortId: 'labcard8',
    title: 'Lab demo: local storage',
    description:
      'Attachments in the acceptance roundtrip use the owned LocalStack bucket. Temporary CRUD cards are removed after checks, leaving these ten persistent fixtures.',
  },
  {
    shortId: 'labcard9',
    title: 'Lab demo: collaboration',
    description:
      'Synthetic admin and member can collaborate on this private board. The restricted guest supplies negative permission checks without production accounts or copied data.',
  },
  {
    shortId: 'labcar10',
    title: 'Lab demo: multilingual long text',
    description: `${'Complete long UTF-8 paragraph — العربية: تجربة محلية؛ Français: été; 日本語: テスト; emoji 🐦🌍. Preserve every paragraph without truncation.\n\n'.repeat(48)}END OF COMPLETE SYNTHETIC DESCRIPTION`,
  },
];
