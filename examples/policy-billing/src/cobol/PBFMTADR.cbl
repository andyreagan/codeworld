       IDENTIFICATION DIVISION.
       PROGRAM-ID. PBFMTADR.
      * Formats an owner address for a printed statement: drops
      * empty lines and upper-cases the city and state.
       DATA DIVISION.
       LINKAGE SECTION.
       01  LS-ADDRESS              PIC X(120).
       01  LS-BLOCK                PIC X(200).
       PROCEDURE DIVISION USING LS-ADDRESS LS-BLOCK.
           MOVE SPACES TO LS-BLOCK
           IF LS-ADDRESS NOT = SPACES
               PERFORM 1000-SPLIT-LINES
               PERFORM 2000-CASE-CITY
           END-IF
           GOBACK.
       1000-SPLIT-LINES.
           UNSTRING LS-ADDRESS DELIMITED BY '|' INTO LS-BLOCK.
       2000-CASE-CITY.
           INSPECT LS-BLOCK CONVERTING
               'abcdefghijklmnopqrstuvwxyz' TO
               'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.
