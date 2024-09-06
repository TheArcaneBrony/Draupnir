// Copyright 2022 Gnuxie <Gnuxie@protonmail.com>
// Copyright 2020 The Matrix.org Foundation C.I.C.
//
// SPDX-License-Identifier: AFL-3.0 AND Apache-2.0
//
// SPDX-FileAttributionText: <text>
// This modified file incorporates work from mjolnir
// https://github.com/matrix-org/mjolnir
// </text>

import { MatrixGlob } from "matrix-bot-sdk";
import { ActionError, Ok, isError } from "matrix-protection-suite";
import {
  StringUserID,
  StringRoomID,
  MatrixRoomReference,
} from "@the-draupnir-project/matrix-basic-types";
import {
  DeadDocumentJSX,
  DocumentNode,
  MatrixRoomReferencePresentationSchema,
  MatrixUserIDPresentationType,
  StringPresentationType,
  describeCommand,
  tuple,
} from "@the-draupnir-project/interface-manager";
import { Result } from "@gnuxie/typescript-result";
import { Draupnir } from "../Draupnir";
import { DraupnirInterfaceAdaptor } from "./DraupnirCommandPrerequisites";

type UsersToKick = Map<StringUserID, StringRoomID[]>;

function addUserToKick(
  map: UsersToKick,
  roomID: StringRoomID,
  userID: StringUserID
): UsersToKick {
  const userEntry =
    map.get(userID) ?? ((entry) => (map.set(userID, entry), entry))([]);
  userEntry.push(roomID);
  return map;
}

function renderUsersToKick(usersToKick: UsersToKick): DocumentNode {
  return (
    <fragment>
      <details>
        <summary>
          Kicking {usersToKick.size} unique users from protected rooms.
        </summary>
        {[...usersToKick.entries()].map(([userID, rooms]) => (
          <details>
            <summary>
              Kicking {userID} from {rooms.length} rooms.
            </summary>
            <ul>
              {rooms.map((room) => (
                <li>{room}</li>
              ))}
            </ul>
          </details>
        ))}
      </details>
    </fragment>
  );
}

export const DraupnirKickCommand = describeCommand({
  summary:
    "Kicks a user or all of those matching a glob in a particular room or all protected rooms. `--glob` must be provided to use globs. Can be scoped to a specific room with `--room`. Can be dry run with `--dry-run`.",
  parameters: tuple({
    name: "user",
    acceptor: MatrixUserIDPresentationType,
  }),
  keywords: {
    keywordDescriptions: {
      "dry-run": {
        isFlag: true,
        description:
          "Runs the kick command without actually removing any users.",
      },
      glob: {
        isFlag: true,
        description:
          "Allows globs to be used to kick several users from rooms.",
      },
      room: {
        acceptor: MatrixRoomReferencePresentationSchema,
        description:
          "Allows the command to be scoped to just one protected room.",
      },
    },
  },
  rest: {
    name: "reason",
    acceptor: StringPresentationType,
  },
  async executor(
    draupnir: Draupnir,
    _info,
    keywords,
    reasonParts,
    user
  ): Promise<Result<UsersToKick>> {
    const restrictToRoomReference =
      keywords.getKeywordValue<MatrixRoomReference>("room", undefined);
    const isDryRun =
      draupnir.config.noop ||
      keywords.getKeywordValue<boolean>("dry-run", false);
    const allowGlob = keywords.getKeywordValue<boolean>("glob", false);
    const isGlob =
      user.toString().includes("*") || user.toString().includes("?");
    if (isGlob && !allowGlob) {
      return ActionError.Result(
        "Wildcard bans require an additional argument `--glob` to confirm"
      );
    }
    const restrictToRoom = restrictToRoomReference
      ? await draupnir.clientPlatform
          .toRoomResolver()
          .resolveRoom(restrictToRoomReference)
      : undefined;
    if (restrictToRoom !== undefined && isError(restrictToRoom)) {
      return restrictToRoom;
    }
    const restrictToRoomRevision =
      restrictToRoom === undefined
        ? undefined
        : draupnir.protectedRoomsSet.setMembership.getRevision(
            restrictToRoom.ok.toRoomIDOrAlias()
          );
    const roomsToKickWithin =
      restrictToRoomRevision !== undefined
        ? [restrictToRoomRevision]
        : draupnir.protectedRoomsSet.setMembership.allRooms;
    const reason = reasonParts.join(" ");
    const kickRule = new MatrixGlob(user.toString());
    const usersToKick: UsersToKick = new Map();
    for (const revision of roomsToKickWithin) {
      for (const member of revision.members()) {
        if (kickRule.test(member.userID)) {
          addUserToKick(
            usersToKick,
            revision.room.toRoomIDOrAlias(),
            member.userID
          );
        }
        if (!isDryRun) {
          void draupnir.taskQueue.push(async () => {
            return draupnir.client.kickUser(
              member.userID,
              revision.room.toRoomIDOrAlias(),
              reason
            );
          });
        }
      }
    }
    return Ok(usersToKick);
  },
});

DraupnirInterfaceAdaptor.describeRenderer(DraupnirKickCommand, {
  JSXRenderer(result) {
    if (isError(result)) {
      return Ok(undefined);
    }
    return Ok(<root>{renderUsersToKick(result.ok)}</root>);
  },
});
