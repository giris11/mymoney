// Settings hub (SPEC §8.1): routes /settings/<section> to its editor, with the
// index doubling as the mobile "More" page. Sections live in src/ui/settings.
import { useRoute } from '../router';
import SectionIndex from '../settings/SectionIndex';
import AppearanceSection from '../settings/AppearanceSection';
import AccountsSection from '../settings/AccountsSection';
import CategoriesSection from '../settings/CategoriesSection';
import PayeesSection from '../settings/PayeesSection';
import TagsSection from '../settings/TagsSection';
import RatesSection from '../settings/RatesSection';
import ImportsSection from '../settings/ImportsSection';
import BackupSection from '../settings/BackupSection';

export default function Settings() {
  const route = useRoute();
  const section = route.path.split('/')[2] ?? '';
  switch (section) {
    case 'appearance':
      return <AppearanceSection />;
    case 'accounts':
      return <AccountsSection />;
    case 'categories':
      return <CategoriesSection />;
    case 'payees':
      return <PayeesSection />;
    case 'tags':
      return <TagsSection />;
    case 'rates':
      return <RatesSection />;
    case 'imports':
      return <ImportsSection />;
    case 'backup':
      return <BackupSection />;
    default:
      return <SectionIndex />; // /settings and any unknown subpath
  }
}
