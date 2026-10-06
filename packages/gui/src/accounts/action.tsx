import type { LucideIcon } from "lucide-react";
import { Button, Tooltip, type ButtonProps } from "../ui/index.js";

/** Account verbs share an icon and the native button's keyboard instructions. */
export const AccountAction = ({ icon: Icon, children, ...props }: ButtonProps & { readonly icon: LucideIcon }) => (
  <Tooltip content={children} keys="Enter / Space">
    <Button {...props}><Icon aria-hidden="true" />{children}</Button>
  </Tooltip>
);
