       IDENTIFICATION DIVISION.
       PROGRAM-ID. PBINQ.
      * Online premium inquiry (transaction PBIQ): an agent keys a
      * policy number, gets back the policy and its next premium.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           COPY PBPOLREC.
       01  WS-AMOUNT               PIC S9(7)V99 VALUE 0.
       01  WS-PREMIUM              PIC S9(7)V99 COMP-3.
       01  WS-RESP                 PIC S9(8) COMP.
       PROCEDURE DIVISION.
       0000-MAIN.
           EXEC CICS RECEIVE MAP('PBIQM') MAPSET('PBIQS')
                RESP(WS-RESP) END-EXEC
           PERFORM 1000-READ-POLICY
           IF WS-RESP = 0
               PERFORM 2000-QUOTE
           END-IF
           PERFORM 3000-SEND
           EXEC CICS RETURN TRANSID('PBIQ') END-EXEC.
       1000-READ-POLICY.
           EXEC CICS READ FILE('POLMAST') INTO(POLICY-REC)
                RIDFLD(POL-NUMBER) RESP(WS-RESP) END-EXEC.
       2000-QUOTE.
           EXEC CICS LINK PROGRAM('PBCALC')
                COMMAREA(POLICY-REC) END-EXEC.
       3000-SEND.
           EXEC CICS SEND MAP('PBIQM') MAPSET('PBIQS') ERASE END-EXEC.
