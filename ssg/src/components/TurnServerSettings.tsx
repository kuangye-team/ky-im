import { IceServerSettings, type IceServerSettingsProps } from "./IceServerSettings";

export function TurnServerSettings(props: IceServerSettingsProps) {
  return <IceServerSettings {...props} kind="turn" />;
}
